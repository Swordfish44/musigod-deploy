const { performance } = require('node:perf_hooks');
const os = require('node:os');

const COLORS = {
  PASS: '\x1b[32m',
  WARN: '\x1b[33m',
  FAIL: '\x1b[31m',
  INFO: '\x1b[36m',
  RESET: '\x1b[0m',
  DIM: '\x1b[2m',
};

function colorize(level, text) {
  if (process.env.NO_COLOR) {
    return text;
  }

  return `${COLORS[level] || ''}${text}${COLORS.RESET}`;
}

function formatMs(ms) {
  return `${Math.round(ms)}ms`;
}

function createReporter(title) {
  const start = performance.now();
  const summary = {
    pass: 0,
    warn: 0,
    fail: 0,
    checks_run: 0,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      shell: process.env.ComSpec || process.env.SHELL || 'unknown',
      hostname: os.hostname(),
    },
    resolver_used: [],
  };

  const resolverUsed = new Set();

  function addResolver(name) {
    if (Array.isArray(name)) {
      name.forEach(addResolver);
      return;
    }

    if (name) {
      resolverUsed.add(name);
      summary.resolver_used = Array.from(resolverUsed);
    }
  }

  function line(level, label, detail, options = {}) {
    const elapsed = Number.isFinite(options.durationMs)
      ? ` ${process.env.NO_COLOR ? '' : COLORS.DIM}(${formatMs(options.durationMs)})${process.env.NO_COLOR ? '' : COLORS.RESET}`
      : '';
    const renderedLevel = colorize(level, level.padEnd(4));
    console.log(`${renderedLevel} ${label}${elapsed} ${detail}`);

    if (level === 'PASS' || level === 'WARN' || level === 'FAIL') {
      summary[level.toLowerCase()] += 1;
      summary.checks_run += 1;
    }

    if (options.resolverUsed) {
      addResolver(options.resolverUsed);
    }
  }

  function startSection() {
    console.log(title);
    console.log('Read-only inspection. No DNS records will be modified.');
    console.log('');
  }

  function finish() {
    const totalRuntimeMs = performance.now() - start;
    summary.total_runtime_ms = Math.round(totalRuntimeMs);
    summary.resolver_used = Array.from(resolverUsed);

    console.log('');
    line('INFO', 'runtime', `total ${formatMs(totalRuntimeMs)}`);
    line('INFO', 'summary', JSON.stringify(summary, null, 2));
    console.log('');
    console.log('Read-only inspection complete. No DNS records were modified.');

    process.exitCode = summary.fail > 0 ? 1 : 0;
  }

  return {
    addResolver,
    finish,
    line,
    startSection,
    summary,
  };
}

module.exports = {
  createReporter,
  formatMs,
};
