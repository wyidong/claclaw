#!/usr/bin/env python3
# 给一个命令套上伪终端：标准输入原样转给它，它的输出原样写到标准输出，它退出时跟着退出（同样的退出码）。
# claclaw 用它起各 Claw 的登录命令（login.mjs）：这些命令在管道里不打网址或直接退出，要个终端；
# macOS 自带的 script 对 Node 给的 socket 型 stdin 会报 tcgetattr 错，所以用 Python 的 pty。
import os, pty, sys, select, signal, fcntl, termios, struct

cmd = sys.argv[1:]
if not cmd:
    sys.stderr.write('usage: ptywrap.py <command> [args…]\n'); sys.exit(2)
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
try: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
except OSError: pass
stdin = sys.stdin.fileno(); out = sys.stdout.fileno()
alive = True
def on_term(*_):
    try: os.kill(pid, signal.SIGTERM)
    except OSError: pass
signal.signal(signal.SIGTERM, on_term); signal.signal(signal.SIGINT, on_term)
stdin_open = True
while alive:
    rl = [fd] + ([stdin] if stdin_open else [])
    try: r, _, _ = select.select(rl, [], [], 0.5)
    except InterruptedError: continue
    if fd in r:
        try: d = os.read(fd, 65536)
        except OSError: d = b''
        if not d: alive = False; break
        os.write(out, d)
    if stdin in r:
        try: d = os.read(stdin, 65536)
        except OSError: d = b''
        if not d: stdin_open = False   # 对方关了输入：不再读，命令照跑
        else: os.write(fd, d)
    # 子进程退了但还有输出没读完：再读一轮
    wp, st = os.waitpid(pid, os.WNOHANG)
    if wp == pid:
        try:
            while True:
                r, _, _ = select.select([fd], [], [], 0.2)
                if not r: break
                d = os.read(fd, 65536)
                if not d: break
                os.write(out, d)
        except OSError: pass
        sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st))
_, st = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st))
