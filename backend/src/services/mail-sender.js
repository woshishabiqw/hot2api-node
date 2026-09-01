/**
 * Mail sender service using nodemailer.
 */
const nodemailer = require('nodemailer');
const { getMailConfig, hasRequiredConfig } = require('./mail-config');

let transporter = null;
let cachedConfig = null;

async function getTransporter() {
  const config = await getMailConfig();

  if (!hasRequiredConfig(config)) {
    throw new Error('SMTP 配置不完整');
  }

  if (
    transporter &&
    cachedConfig &&
    cachedConfig.host === config.host &&
    cachedConfig.port === config.port &&
    cachedConfig.secure === config.secure &&
    cachedConfig.user === config.user &&
    cachedConfig.pass === config.pass
  ) {
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });

  cachedConfig = { ...config };
  return transporter;
}

async function sendVerificationCode(to, code) {
  const config = await getMailConfig();
  if (!config.from) {
    throw new Error('发件人未配置');
  }

  const transport = await getTransporter();
  const result = await transport.sendMail({
    from: config.from,
    to,
    subject: '验证码',
    text: `您的验证码是：${code}，5 分钟内有效。`,
    html: `<p>您的验证码是：<strong>${code}</strong></p><p>5 分钟内有效。</p>`,
  });

  return result;
}

function clearCache() {
  transporter = null;
  cachedConfig = null;
}

module.exports = {
  sendVerificationCode,
  getTransporter,
  clearCache,
};
