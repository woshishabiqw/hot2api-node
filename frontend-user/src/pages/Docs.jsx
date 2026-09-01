import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import api from '../lib/api';

export default function Docs() {
  const [gatewayUrls, setGatewayUrls] = useState([]);
  const [selectedUrl, setSelectedUrl] = useState('');
  const [unconfigured, setUnconfigured] = useState(false);

  useEffect(() => {
    api.get('/user/settings').then(res => {
      try {
        const urls = JSON.parse(res.data.gateway_urls || '[]');
        const active = Array.isArray(urls) ? urls.filter(u => u.active) : [];
        // Gateway URLs are API endpoints (not web portals). Prefer nginx-type APIs.
        const nginx = active.filter(u => u.type === 'nginx');
        const node = active.filter(u => u.type === 'node');
        const chosen = nginx.length > 0 ? nginx : (node.length > 0 ? node : active);
        if (chosen.length > 0) {
          setGatewayUrls(active);
          setSelectedUrl(chosen[0].url);
          setUnconfigured(false);
        } else if (res.data.gateway_url) {
          setGatewayUrls([{ name: '默认', url: res.data.gateway_url }]);
          setSelectedUrl(res.data.gateway_url);
          setUnconfigured(false);
        } else {
          setUnconfigured(true);
        }
      } catch {
        setUnconfigured(true);
      }
    }).catch(() => {
      setUnconfigured(true);
    });
  }, []);

  const baseUrl = selectedUrl;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">接口文档</h1>

      <Card>
        <CardHeader>
          <CardTitle>快速开始</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground">
            将此网关作为 OpenAI 或 Anthropic API 的直接替代使用。
            只需更改基础URL并使用您的网关API密钥。
          </p>
          {gatewayUrls.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">选择节点：</span>
              <select
                className="h-8 rounded border bg-background px-2 text-sm"
                value={selectedUrl}
                onChange={(e) => setSelectedUrl(e.target.value)}
              >
                {gatewayUrls.map((u, i) => (
                  <option key={i} value={u.url}>{u.name} - {u.url}</option>
                ))}
              </select>
            </div>
          )}
          <div className="p-4 bg-muted rounded-lg">
            {unconfigured ? (
              <span className="text-sm text-amber-600">未配置可用的 API 网关地址，请联系管理员在系统设置中配置。</span>
            ) : (
              <code className="text-sm">基础URL: {baseUrl}</code>
            )}
          </div>
        </CardContent>
      </Card>

      {!unconfigured && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>OpenAI 兼容接口</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h4 className="font-medium mb-2">聊天补全</h4>
                <pre className="p-4 bg-muted rounded-lg text-sm overflow-x-auto">
{`POST ${baseUrl}/v1/chat/completions
Authorization: Bearer 您的网关密钥
Content-Type: application/json

{
  "model": "your-model-name",
  "messages": [
    {"role": "user", "content": "你好！"}
  ]
}`}
                </pre>
              </div>

              <div>
                <h4 className="font-medium mb-2">模型列表</h4>
                <pre className="p-4 bg-muted rounded-lg text-sm overflow-x-auto">
{`GET ${baseUrl}/v1/models
Authorization: Bearer 您的网关密钥`}
                </pre>
              </div>

              <div>
                <h4 className="font-medium mb-2">Python 示例</h4>
                <pre className="p-4 bg-muted rounded-lg text-sm overflow-x-auto">
{`from openai import OpenAI

client = OpenAI(
    api_key="您的网关密钥",
    base_url="${baseUrl}/v1"
)

response = client.chat.completions.create(
    model="your-model-name",
    messages=[{"role": "user", "content": "你好！"}]
)

print(response.choices[0].message.content)`}
                </pre>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Anthropic 兼容接口</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h4 className="font-medium mb-2">消息</h4>
                <pre className="p-4 bg-muted rounded-lg text-sm overflow-x-auto">
{`POST ${baseUrl}/v1/messages
x-api-key: 您的网关密钥
anthropic-version: 2023-06-01
Content-Type: application/json

{
  "model": "your-model-name",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "你好！"}
  ]
}`}
                </pre>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
