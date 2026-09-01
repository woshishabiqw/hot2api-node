import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  console.log('[API] request interceptor, token prefix:', token?.substring(0, 20), 'url:', config.url);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const url = error.config?.url || '';
      // 排除登录请求本身，避免登录失败时页面刷新导致错误提示消失
      const isLoginRequest = url.includes('/auth/login');
      if (isLoginRequest) {
        return Promise.reject(error);
      }
      const code = error.response?.data?.code;
      const currentToken = localStorage.getItem('token');
      console.log('[API] 401 on', url, 'code:', code, 'token prefix:', currentToken?.substring(0, 20), 'debug_prefix:', error.response?.data?.debug_prefix);
      // 二次验证相关错误不要删主 token，让业务层处理
      if (code === 'SECOND_AUTH_REQUIRED' || code === 'SECOND_AUTH_EXPIRED' || code === 'SECOND_AUTH_INVALID' || code === 'SECOND_AUTH_RESET') {
        return Promise.reject(error);
      }
      localStorage.removeItem('token');
      // Let PrivateRoute handle redirect, don't force page refresh
    }
    return Promise.reject(error);
  }
);

export default api;
