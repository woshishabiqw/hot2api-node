const { parentPort } = require('worker_threads');

// 启发式规则：命中任意一条即视为 danger
const DANGER_RULES = [
  { id: 'pe_header', name: 'Windows executable (MZ)', pattern: /MZ/ },
  { id: 'elf_header', name: 'Linux ELF binary', pattern: /\x7fELF/ },
  { id: 'zip_jar', name: 'ZIP/JAR archive', pattern: /PK\x03\x04/ },
  { id: 'powershell', name: 'PowerShell invocation', pattern: /powershell/i },
  { id: 'encoded_cmd', name: 'Encoded command flag', pattern: /-(?:enc|encodedcommand)\s+/i },
  { id: 'iex', name: 'IEX (PowerShell eval)', pattern: /\bIEX\b/i },
  { id: 'invoke_expression', name: 'Invoke-Expression', pattern: /Invoke-Expression/i },
  { id: 'cmd_exe', name: 'cmd.exe', pattern: /cmd\.exe/i },
  { id: 'bin_shell', name: '/bin/sh or /bin/bash', pattern: /\/bin\/(?:sh|bash)\b/ },
  { id: 'bash_c', name: 'bash -c', pattern: /bash\s+-c/i },
  { id: 'curl_pipe_shell', name: 'curl | shell', pattern: /curl\s+[^|\n]+\|\s*(?:sh|bash|zsh|dash)/i },
  { id: 'wget_pipe_shell', name: 'wget | shell', pattern: /wget\s+[^|\n]+\|\s*(?:sh|bash|zsh|dash)/i },
  { id: 'python_c', name: 'python -c', pattern: /python(?:3)?\s+-c/i },
  { id: 'perl_e', name: 'perl -e', pattern: /perl\s+-e/i },
  { id: 'php_tag', name: 'PHP tag', pattern: /<\?php/i },
  { id: 'script_tag', name: 'HTML script tag', pattern: /<script\b/i },
  { id: 'javascript_scheme', name: 'javascript: URL scheme', pattern: /javascript:/i },
  { id: 'eval_call', name: 'eval() call', pattern: /eval\s*\(/i },
  { id: 'document_write', name: 'document.write', pattern: /document\.write/i },
  { id: 'from_char_code', name: 'String.fromCharCode', pattern: /fromCharCode/i },
  { id: 'activex', name: 'ActiveXObject', pattern: /ActiveXObject/i },
  { id: 'wscript_shell', name: 'WScript.Shell', pattern: /WScript\.Shell/i },
  { id: 'create_object', name: 'CreateObject', pattern: /CreateObject\s*\(/i },
  { id: 'atob_call', name: 'atob() call', pattern: /atob\s*\(/i },
  { id: 'long_b64_exec', name: 'Long base64 followed by execution', pattern: /[A-Za-z0-9+/]{80,}={0,2}[\s\S]{0,80}(?:eval|IEX|Invoke-Expression|bash -c|powershell|cmd\.exe)/i }
];

function scan(payload) {
  if (!payload || typeof payload !== 'string') {
    return { result: 'unknown', matchedRules: [], details: 'empty or non-string payload' };
  }

  const matched = [];
  for (const rule of DANGER_RULES) {
    if (rule.pattern.test(payload)) {
      matched.push({ id: rule.id, name: rule.name });
    }
  }

  if (matched.length > 0) {
    return {
      result: 'danger',
      matchedRules: matched,
      details: `命中 ${matched.length} 条危险规则：${matched.map(r => r.name).join('、')}`
    };
  }

  // 包含不可打印空字节时视为未知二进制内容
  if (payload.indexOf('\u0000') !== -1) {
    return { result: 'unknown', matchedRules: [], details: '包含二进制空字节，无法安全判定' };
  }

  return { result: 'safe', matchedRules: [], details: '未命中已知恶意特征' };
}

parentPort.on('message', (task) => {
  try {
    const result = scan(task.payload);
    parentPort.postMessage({ id: task.id, result });
  } catch (err) {
    parentPort.postMessage({ id: task.id, result: { result: 'unknown', matchedRules: [], details: `扫描异常：${err.message}` } });
  }
});
