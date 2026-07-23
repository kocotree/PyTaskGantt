const { spawn } = require('child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npmCommand, ['run', 'server'], { stdio: 'inherit', shell: false }),
  spawn(npmCommand, ['run', 'dev'], { stdio: 'inherit', shell: false }),
];
let stopping = false;

function stop(signal = 'SIGTERM', exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on('error', error => {
    console.error(`开发进程启动失败：${error.message}`);
    stop('SIGTERM', 1);
  });
  child.on('exit', code => {
    if (!stopping) stop('SIGTERM', code || 0);
  });
}

process.on('SIGINT', () => stop('SIGINT', 0));
process.on('SIGTERM', () => stop('SIGTERM', 0));
