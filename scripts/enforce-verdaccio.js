/**
 * 强制使用 Verdaccio 本地 registry 安装 npm 模块。
 * 作为 preinstall 钩子运行：当检测到显式安装模块且 registry 不是 Verdaccio 时直接退出并报错。
 */

const { execSync } = require('child_process');

const VERDACCIO_HOSTS = [
  'http://localhost:3011',
  'https://localhost:3011'
];

function getEffectiveRegistry() {
  // npm 会在环境变量中注入当前生效的 registry
  if (process.env.npm_config_registry) {
    return process.env.npm_config_registry;
  }
  try {
    return execSync('npm config get registry', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function isVerdaccio(registry) {
  if (!registry) return false;
  return VERDACCIO_HOSTS.some(host => registry.startsWith(host));
}

function shouldEnforce() {
  const cmd = process.env.npm_command || process.env.npm_lifecycle_event;
  // 只拦截安装类命令（install / ci / add / i）
  if (!['install', 'ci', 'add', 'i'].includes(cmd)) return false;

  // npm <= v6 会提供 npm_config_argv，可精确判断 install 是否带了包名
  if ((cmd === 'install' || cmd === 'add' || cmd === 'i') && process.env.npm_config_argv) {
    try {
      const argv = JSON.parse(process.env.npm_config_argv);
      const original = argv.original || [];
      const packages = original.filter(arg =>
        typeof arg === 'string' &&
        !arg.startsWith('-') &&
        !['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'add'].includes(arg)
      );
      return packages.length > 0;
    } catch {
      // 解析失败时按“需要拦截”处理
    }
  }

  // install / ci / add 等没有显式包名参数时（如 npm install、npm ci），
  // 只要 registry 不是 Verdaccio 也拦截，防止整个 lock 被官方 registry 污染。
  return true;
}

const registry = getEffectiveRegistry();

if (shouldEnforce() && !isVerdaccio(registry)) {
  console.error('\n[ERROR] 直接通过 npm 官方 registry 安装模块已被禁用。');
  console.error('请使用本地 Verdaccio registry，例如：');
  console.error('  npm config set registry http://localhost:3011/');
  console.error('  npm install <module>');
  console.error('\n或者在项目根目录的 .npmrc 中配置：');
  console.error('  registry=http://localhost:3011/');
  console.error('\n若 Verdaccio 未启动，请先执行：');
  console.error('  npm run registry:start\n');
  process.exit(1);
}
