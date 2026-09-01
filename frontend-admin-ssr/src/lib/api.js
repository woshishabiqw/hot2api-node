import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Attach second auth token if available
  const secondToken = localStorage.getItem('second_auth_token');
  if (secondToken) {
    config.headers['X-Second-Auth-Token'] = secondToken;
  }
  // Attach payment auth token if available
  const paymentToken = localStorage.getItem('payment_auth_token');
  if (paymentToken) {
    config.headers['X-Payment-Auth-Token'] = paymentToken;
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

      // 排除 PIN 验证失败（密码错误），不要让拦截器把密码错误当成认证过期
      const isPinVerify = url.includes('/auth/second-password/verify') || url.includes('/auth/payment-password/verify');
      if (isPinVerify) {
        return Promise.reject(error);
      }

      const code = error.response?.data?.code;
      // If it's a second auth issue, don't clear main token - let SecondAuthGate handle it
      if (code === 'SECOND_AUTH_REQUIRED' || code === 'SECOND_AUTH_EXPIRED' || code === 'SECOND_AUTH_INVALID' || code === 'SECOND_AUTH_RESET') {
        localStorage.removeItem('second_auth_token');
        // Dispatch a custom event so SecondAuthGate can react
        window.dispatchEvent(new CustomEvent('second-auth-required'));
        return Promise.reject(error);
      }
      // Main auth expired
      localStorage.removeItem('token');
      localStorage.removeItem('second_auth_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
