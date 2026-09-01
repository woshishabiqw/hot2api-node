const db = require('../src/config/database');
const invoiceService = require('../src/services/invoice');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

async function getTestUserAndWorkspace() {
  const user = await db.get("SELECT * FROM users WHERE username = 'testuser_ui'");
  if (!user) throw new Error('testuser_ui not found');
  const ws = await db.get(
    `SELECT w.*, wm.role as member_role FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id WHERE wm.user_id = ? LIMIT 1`,
    [user.id]
  );
  if (!ws) throw new Error('No workspace for testuser_ui');
  return { user, ws };
}

async function createPaidOrder(user, ws, amount) {
  const tradeNo = `TST${Date.now()}${crypto.randomInt(1000, 9999)}`;
  const res = await db.run(
    `INSERT INTO payment_orders (workspace_id, user_id, amount, channel, status, trade_no, description, paid_at)
     VALUES (?, ?, ?, 'mock', 'paid', ?, '测试订单', datetime('now'))`,
    [ws.id, user.id, amount, tradeNo]
  );
  return db.get('SELECT * FROM payment_orders WHERE id = ?', [res.lastInsertRowid]);
}

async function cleanup(order, invoice) {
  if (invoice?.invoice_file_path && fs.existsSync(invoice.invoice_file_path)) {
    fs.unlinkSync(invoice.invoice_file_path);
  }
  if (invoice?.id) await db.run('DELETE FROM invoices WHERE id = ?', [invoice.id]);
  if (order?.id) await db.run('DELETE FROM payment_orders WHERE id = ?', [order.id]);
}

async function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log('[TEST] 准备测试数据');
  const { user, ws } = await getTestUserAndWorkspace();
  const amount = 12.34;
  const order = await createPaidOrder(user, ws, amount);
  console.log('[TEST] 已创建已支付订单', order.id, order.trade_no);

  let invoice;
  try {
    console.log('[TEST] 提交开票申请');
    invoice = await invoiceService.issueInvoiceForOrder(order);
    await assert(invoice.status === 'pending', `开票后状态应为 pending，实际 ${invoice.status}`);
    await assert(invoice.review_status === 'pending', `审核状态应为 pending`);
    console.log('[TEST] ✓ 开票申请已提交，处于待处理');

    console.log('[TEST] 测试 24 小时冷却限制');
    let cooldownError = null;
    try {
      await invoiceService.issueInvoiceForOrder(order);
    } catch (e) {
      cooldownError = e;
    }
    await assert(cooldownError && cooldownError.message.includes('24 小时'), '应阻止 24 小时内重复开票');
    console.log('[TEST] ✓ 24 小时内重复开票被阻止');

    console.log('[TEST] 模拟审核通过并生成文件');
    invoice = await invoiceService.markIssued(invoice.id);
    await assert(invoice.status === 'issued', `审核后状态应为 issued`);
    await assert(invoice.review_status === 'approved', `审核状态应为 approved`);
    await assert(invoice.invoice_no && invoice.invoice_no.startsWith('INV'), `应有发票号`);
    await assert(invoice.invoice_file_path && fs.existsSync(invoice.invoice_file_path), `应生成 xlsx 文件`);
    console.log('[TEST] ✓ 发票已开具，文件存在:', invoice.invoice_file_path);

    console.log('[TEST] 验证 xlsx 文件内容');
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(invoice.invoice_file_path);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    await assert(data.some(row => row.includes('电子发票')), 'xlsx 应包含电子发票标题');
    await assert(data.some(row => row[0] === '发票号码' && String(row[1]).startsWith('INV')), 'xlsx 应包含发票号');
    console.log('[TEST] ✓ xlsx 文件内容正确');

    console.log('[TEST] 验证文件有效期字段');
    await assert(invoice.invoice_file_created_at, `应有 invoice_file_created_at`);
    const expiry = invoiceService.getFileExpiry(invoice);
    await assert(expiry, `应计算有效期`);
    const days = (expiry.getTime() - new Date(invoice.invoice_file_created_at).getTime()) / (24 * 60 * 60 * 1000);
    await assert(Math.abs(days - 30) < 1, `有效期应为 30 天，实际 ${days}`);
    console.log('[TEST] ✓ 文件有效期为 30 天');

    console.log('[TEST] 测试过期移除');
    // Simulate expired by setting created_at 31 days ago
    await db.run(
      `UPDATE invoices SET invoice_file_created_at = datetime('now', '-31 days') WHERE id = ?`,
      [invoice.id]
    );
    invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoice.id]);
    await assert(invoiceService.isFileExpired(invoice), `应判定为已过期`);
    invoice = await invoiceService.markRemoved(invoice.id);
    await assert(invoice.status === 'removed', `过期后状态应为 removed`);
    await assert(!invoice.invoice_file_path || !fs.existsSync(invoice.invoice_file_path), `过期后文件应被删除`);
    console.log('[TEST] ✓ 过期移除逻辑正确');

    console.log('[TEST] 清理测试数据');
    await cleanup(order, invoice);
    console.log('\n🎉 发票生命周期测试全部通过');
  } catch (err) {
    console.error('\n❌ 测试失败:', err.message);
    await cleanup(order, invoice).catch(() => {});
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
