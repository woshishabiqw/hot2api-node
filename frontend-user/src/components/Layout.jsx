import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { useState, useEffect, useRef } from 'react';
import { cn } from '../lib/utils';
import Banner from './Banner';
import {
  LayoutDashboard,
  Key,
  FileText,
  Book,
  Cpu,
  Moon,
  Sun,
  LogOut,
  Menu,
  X,
  Building2,
  Wallet,
  ChevronDown,
  ChevronRight,
  MessageSquare
} from 'lucide-react';

const navItems = [
  { href: '/', label: '仪表盘', icon: LayoutDashboard },
  { href: '/workspaces', label: 'Workspace', icon: Building2 },
  { href: '/models', label: '模型广场', icon: Cpu },
  { href: '/keys', label: 'API密钥', icon: Key },
  { href: '/chat', label: '网页聊天', icon: MessageSquare },
  {
    label: '我的钱包',
    icon: Wallet,
    children: [
      { href: '/wallet', label: '钱包 / 订单' },
      { href: '/coupons', label: '优惠券管理' },
    ]
  },
  { href: '/usage', label: '用量明细', icon: FileText },
  { href: '/docs', label: '接口文档', icon: Book },
];

export default function Layout({ children }) {
  const location = useLocation();
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const contentRef = useRef(null);

  const [expandedMenus, setExpandedMenus] = useState(() => {
    const matched = navItems.find(item =>
      item.children?.some(c => c.href === location.pathname)
    );
    return matched ? { [matched.label]: true } : {};
  });

  useEffect(() => {
    const matched = navItems.find(item =>
      item.children?.some(c => c.href === location.pathname)
    );
    if (matched) {
      setExpandedMenus(prev => ({ ...prev, [matched.label]: true }));
    }
  }, [location.pathname]);

  // Reset the main content scroll to top on route change / initial load so
  // refreshing the page doesn't leave the user at the bottom. Disable browser
  // scroll restoration and re-apply reset after a tick to override it.
  useEffect(() => {
    if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
    const reset = () => contentRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    reset();
    const t = setTimeout(reset, 50);
    return () => clearTimeout(t);
  }, [location.pathname]);

  const toggleMenu = (label) => {
    setExpandedMenus(prev => ({ ...prev, [label]: !prev[label] }));
  };

  const toggleTheme = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  return (
    <div className="min-h-[111.11vh] bg-background">
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-64 bg-card border-r transform transition-transform duration-200 ease-in-out lg:translate-x-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between h-16 px-6 border-b">
            <span className="text-xl font-bold text-primary">F***(法克)网关</span>
            <button onClick={() => setSidebarOpen(false)} className="lg:hidden">
              <X className="w-5 h-5" />
            </button>
          </div>
          
          <nav className="flex-1 min-h-0 px-4 py-4 space-y-1 overflow-y-auto">
            {navItems.map((item) => {
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
                        {item.children.map((child) => {
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
            <div className="flex items-center justify-between">
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

      <main className="lg:pl-64 pt-9 flex flex-col h-[111.11vh] overflow-hidden">
        <Banner />
        <header className="sticky top-0 z-30 flex items-center h-16 px-6 bg-background border-b lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-md hover:bg-accent"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="ml-4 font-semibold">F***(法克)网关</span>
        </header>

        <div ref={contentRef} className="flex-1 flex flex-col min-h-0 pt-6 px-6 pb-6 overflow-y-auto custom-scrollbar">
          {children}
        </div>
      </main>
    </div>
  );
}
