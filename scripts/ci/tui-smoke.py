#!/usr/bin/env python3
"""Exercise the real terminal with a mock model and bounded waits (needs pyte)."""
import codecs
import fcntl
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import tempfile
import termios
import time
import pyte

logs = Path('build-ci')
logs.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='sope-pty-') as scratch:
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(TERM='xterm-256color', SOPE_GRAPHICS='0', SOPE_API_KEY='',
                          SOPE_DB=f'{scratch}/session.db', XDG_CONFIG_HOME=f'{scratch}/config')
        os.execl(shutil.which('bun'), 'bun', 'tui/src/main.ts', '--provider', 'mock',
                 '--effort', 'medium', 'hello CI')
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 112, 0, 0))
    screen = pyte.Screen(112, 40)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder('utf8')('replace')
    reaped = False

    def text():
        return '\n'.join(screen.display)

    def drain():
        if select.select([fd], [], [], 0.1)[0]:
            try:
                stream.feed(decoder.decode(os.read(fd, 65536)))
            except OSError:
                pass # Linux reports EIO when the PTY slave closes.

    def until(needle, seconds=20, present=True):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if (needle in text()) == present:
                return
            drain()
        raise AssertionError(f'Expected {needle!r} present={present}\n{text()}')

    try:
        until('You said: hello CI')
        os.write(fd, b'/context\r')
        until('Context')
        (logs / 'tui-context.txt').write_text(text())
        os.write(fd, b'/effort\r')
        until('Reasoning effort')
        (logs / 'tui-effort.txt').write_text(text())
        os.write(fd, b'\x1b')
        # Wait for the actual close before sending more input. If a busy
        # runner coalesces ESC and /quit, the decoder sees an Alt sequence
        # and the popup consumes the command instead of closing first.
        until('Reasoning effort', present=False)
        os.write(fd, b'/quit\r')
        end = time.monotonic() + 10
        while time.monotonic() < end:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                reaped = True
                assert os.waitstatus_to_exitcode(status) == 0, status
                break
            drain() # The application must be able to flush output before exiting.
        else:
            raise AssertionError(f'TUI did not exit\n{text()}')
        print('PTY conversation, /context, /effort and clean exit passed')
    finally:
        (logs / 'tui-final.txt').write_text(text())
        if not reaped:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(fd)
