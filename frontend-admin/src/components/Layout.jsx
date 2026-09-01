import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import {
  LayoutDashboard,
  Key,
  Users,
  Settings,
  Moon,
  Sun,
  LogOut,
  Menu,
  X,
  ChevronDown,
  ChevronRight,
  Cpu,
  Shield,
  Building2,
  CreditCard,
  Landmark,
  Route,
  Database,
  ClipboardList,
  Wallet,
  HardDrive
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { cn } from '../lib/utils';
import Banner from './Banner';

export default function Layout({ children }) {
  const location = useLocation();
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [routingMode, setRoutingMode] = useState('auto');
  const navItems = [
    { href: '/', label: '仪表盘', icon: LayoutDashboard },
    {
      label: '模型总揽',
      icon: Key,
      children: [
        { href: '/sources', label: '源站列表' },
        { href: '/probe', label: '源站延迟' },
        { href: '/model-plaza-config', label: '模型广场配置' },
        { href: '/model-groups', label: '模型分组' },
        { href: '/routing', label: '源站路由管理', manualOnly: true },
      ]
    },
    {
      label: '财务管理',
      icon: Wallet,
      children: [
        { href: '/billing', label: '计费中心' },
        { href: '/orders', label: '订单管理' },
        { href: '/invoices', label: '发票管理' },
        { href: '/payment-gateway', label: '支付渠道' },
        { href: '/coupons', label: '优惠券管理' },
      ]
    },
    {
      label: '日志管理',
      icon: ClipboardList,
      roles: ['admin'],
      children: [
        { href: '/audit-logs', label: '日志查看' },
        { href: '/log-management', label: '日志管理系统' },
      ]
    },
    {
      label: '用户管理',
      icon: Users,
      roles: ['admin'],
      children: [
        { href: '/users/current', label: '用户列表' },
        { href: '/users/new-config', label: '新用户配置' },
        { href: '/users/registration', label: '注册管理' },
      ]
    },
    {
      label: '数据管理',
      icon: Database,
      children: [
        { href: '/database-status', label: '数据库状态' },
        { href: '/cache-management', label: '缓存管理' },
      ]
    },

    {
      label: '系统设置',
      icon: Settings,
      roles: ['admin'],
      children: [
        { href: '/settings', label: '系统配置' },
        { href: '/settings/security', label: '安全管理' },
        { href: '/webchat-config', label: '网页聊天配置' },
      ]
    },
    { href: '/workspaces', label: 'Workspace', icon: Building2 },
  ];

  const [expandedMenus, setExpandedMenus] = useState(() => {
    const matched = navItems.find(item =>
      item.children?.some(c => c.href === location.pathname)
    );
    return matched ? { [matched.label]: true } : {};
  });

  useEffect(() => {
    const loadRoutingMode = async () => {
      try {
        // 优先从 localStorage 读取，保持用户选择
        const localMode = localStorage.getItem('routingMode');
        if (localMode) {
          setRoutingMode(localMode);
        }

        // 从 API 加载最新状态并同步到 localStorage
        const res = await api.get('/admin/routing/status');
        const apiMode = res.data?.settings?.mode || 'auto';
        setRoutingMode(apiMode);
        localStorage.setItem('routingMode', apiMode);
      } catch (e) {
        console.error('[Layout] Failed to load routing mode:', e);
        // 如果 API 失败，使用 localStorage 的值
        const localMode = localStorage.getItem('routingMode');
        setRoutingMode(localMode || 'auto');
      }
    };
    loadRoutingMode();

    // 监听路由模式变化事件
    const handleRoutingModeChange = () => {
      const newMode = localStorage.getItem('routingMode') || 'auto';
      setRoutingMode(newMode);
    };
    window.addEventListener('routingModeChanged', handleRoutingModeChange);
    return () => window.removeEventListener('routingModeChanged', handleRoutingModeChange);
  }, []);

  useEffect(() => {
    const matched = navItems.find(item => 
      item.children?.some(c => c.href === location.pathname)
    );
    if (matched) {
      setExpandedMenus(prev => ({ ...prev, [matched.label]: true }));
    }
  }, [location.pathname]);

  const toggleMenu = (label) => {
    setExpandedMenus(prev => ({ ...prev, [label]: !prev[label] }));
  };

  const toggleTheme = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  return (
    <div className="min-h-screen bg-background">
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-64 bg-card border-r transform transition-transform duration-200 ease-in-out lg:translate-x-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex flex-col h-full">
          <div className="flex flex-col justify-center h-16 px-6 border-b">
            <span className="text-xl font-bold">F***(法克)中转站管理</span>
            <span className="text-[10px] text-muted-foreground mt-0.5">点击侧边栏外部即可关闭侧边栏</span>
          </div>
          
          <nav className="flex-1 min-h-0 px-4 py-4 space-y-1 overflow-y-auto">
            {navItems.filter(item => !item.roles || item.roles.includes(user?.role)).map((item) => {
              const Icon = item.icon;
              if (item.children) {
                const isExpanded = expandedMenus[item.label];
                const isChildActive = item.children.some(c => location.pathname === c.href);
                return (
                  <div key={item.label} className="space-y-1">
                    <button
                      onClick={() => toggleMenu(item.label)}
                      className={cn(
                        "w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                        isChildActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <Icon className="w-5 h-5" />
                        {item.label}
                      </div>
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 shrink-0" />
                      )}
                    </button>
                    {isExpanded && (
                      <div className="ml-6 space-y-1">
                        {item.children.filter(child => !child.manualOnly || routingMode === 'manual').map((child) => {
                          const isActive = location.pathname === child.href;
                          return (
                            <Link
                              key={child.href}
                              to={child.href}
                              onClick={() => setSidebarOpen(false)}
                              className={cn(
                                "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors",
                                isActive
                                  ? "bg-primary text-primary-foreground"
                                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                              )}
                            >
                              {child.label}
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Icon className="w-5 h-5" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="p-4 border-t">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-muted-foreground">
                {user?.username}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={toggleTheme}
                  className="p-2 rounded-md hover:bg-accent"
                  title="切换主题"
                >
                  {theme === 'dark' ? (
                    <Sun className="w-4 h-4" />
                  ) : (
                    <Moon className="w-4 h-4" />
                  )}
                </button>
                <button
                  onClick={logout}
                  className="p-2 rounded-md hover:bg-accent text-destructive"
                  title="退出登录"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="lg:pl-64 pt-9">
        <Banner />
        <header className="sticky top-0 z-30 flex items-center h-16 px-6 bg-background border-b lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-md hover:bg-accent"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="ml-4 font-semibold">F***(法克)中转站管理</span>
        </header>

        <div className="p-4 md:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
