/**
 * AdminEvents - 通用管理后台 SSE 广播服务
 * 为 /admin/events/stream 提供客户端管理与事件推送。
 */

class AdminEvents {
  constructor() {
    this.clients = new Set();
  }

  addClient(res) {
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
    });
    // 发送一条连接成功事件，帮助前端确认通道已就绪
    this._send(res, 'connected', { time: new Date().toISOString() });
  }

  broadcast(event, payload = {}) {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    const dead = [];
    for (const client of this.clients) {
      try {
        client.write(data);
      } catch (e) {
        dead.push(client);
      }
    }
    for (const client of dead) {
      this.clients.delete(client);
      try { client.end(); } catch (e) {}
    }
  }

  _send(res, event, payload) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {}
  }

  getClientCount() {
    return this.clients.size;
  }
}

module.exports = new AdminEvents();
