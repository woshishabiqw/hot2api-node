import axios from 'axios';
import { requestSecondAuth } from './second-auth-request';

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
  async (error) => {
    if (error.response?.status === 401) {
      const originalRequest = error.config;
      const url = originalRequest?.url || '';
      // 排除登录请求本身，避免登录失败时页面刷新导致错误提示消失
      const isLoginRequest = url.includes('/auth/login');
      if (isLoginRequest) {
        return Promise.reject(error);
      }

      // 排除 PIN 验证/设置请求本身，避免递归弹窗
      const isPinRequest = url.includes('/auth/second-password/verify')
        || url.includes('/auth/second-password/setup')
        || url.includes('/auth/second-password/status')
        || url.includes('/auth/payment-password/verify')
        || url.includes('/auth/payment-password/setup')
        || url.includes('/auth/payment-password/status');
      if (isPinRequest) {
        return Promise.reject(error);
      }

      const code = error.response?.data?.code;
      // If it's a second auth issue, pop the dialog and retry the request
      if (code === 'SECOND_AUTH_REQUIRED' || code === 'SECOND_AUTH_EXPIRED' || code === 'SECOND_AUTH_INVALID' || code === 'SECOND_AUTH_RESET') {
        if (originalRequest._secondAuthRetry) {
          return Promise.reject(error);
        }
        originalRequest._secondAuthRetry = true;
        localStorage.removeItem('second_auth_token');

        try {
          const token = await requestSecondAuth({ reason: '当前操作需要二级密码验证', force: true });
          originalRequest.headers['X-Second-Auth-Token'] = token;
          return api(originalRequest);
        } catch (e) {
          // 用户取消或未通过验证，让原请求失败
          return Promise.reject(error);
        }
      }

      // Main auth expired
      localStorage.removeItem('token');
      localStorage.removeItem('second_auth_token');
      // Notify the app so it can redirect to login without waiting for a re-render
      window.dispatchEvent(new CustomEvent('main-auth-expired'));
    }
    return Promise.reject(error);
  }
);

export default api;
