#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Wheel regressions against a real TUI process in a PTY (requires pyte).

Uses a throwaway saved transcript; no model requests or user session writes.
Run with --executable /absolute/path/to/sope to test a compiled build.
--graphics exercises Kitty negotiation/overlays as used by Ghostty; pyte
checks the text viewport, not the terminal's pixel compositor.
"""
import argparse
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

import pyte

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--executable', type=Path)
parser.add_argument('--graphics', action='store_true')
parser.add_argument('--speed', type=int, default=1)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
bun = shutil.which('bun')
command = [str(args.executable.resolve())] if args.executable else [bun, str(root / 'tui/src/main.ts')]
command += ['--provider', 'mock']

with tempfile.TemporaryDirectory(prefix='sope-scroll-') as scratch:
    directory = str(Path(scratch).resolve())
    db = f'{directory}/session.db'
    seed = f'''
      import {{ Store }} from {json.dumps(str(root / 'tui/src/store.ts'))};
      const store = new Store(process.argv[1]);
      store.create('scroll-fixture', process.cwd(), 'scroll fixture');
      store.save('scroll-fixture', {{title:'scroll fixture', tokensIn:0, tokensOut:0, context:0}},
        new Map([[0, {{role:'assistant', text:Array.from({{length:600}}, (_, i) =>
          'scroll-row-' + String(i).padStart(4, '0')).join('\\n')}}]]), 1);
      store.close();
    '''
    subprocess.run([bun, '-e', seed, db], cwd=directory, check=True)
    pid, fd = pty.fork()
    if pid == 0:
        # Do not inherit a user's provider, permissions, model or speed overrides.
        library = os.environ.get('SOPE_LIB')
        for key in list(os.environ):
            if key.startswith('SOPE_'):
                del os.environ[key]
        if library and not args.executable:
            os.environ['SOPE_LIB'] = library
        os.environ.update(TERM='xterm-256color', SOPE_API_KEY='', SOPE_DB=db,
                          SOPE_MOUSE='1', SOPE_SCROLL_SPEED=str(args.speed),
                          SOPE_GRAPHICS='1' if args.graphics else '0',
                          XDG_CONFIG_HOME=f'{directory}/config')
        for key in ('TMUX', 'STY', 'ZELLIJ'):
            os.environ.pop(key, None)
        os.chdir(directory)
        os.execv(command[0], command)

    screen = pyte.Screen(112, 40)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder('utf8')('replace')
    pending = b''
    positions = []
    graphics_seen = False
    reaped = False
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 112, 0, 0))

    def top():
        for line in screen.display:
            match = re.search(r'scroll-row-(\d+)', line)
            if match:
                return int(match[1])
        return None

    def drain(timeout=0.01):
        global pending, graphics_seen
        if not select.select([fd], [], [], timeout)[0]:
            return
        try:
            pending += os.read(fd, 65536)
        except OSError:
            return
        end = b'\x1b[?2026l'
        while end in pending:
            frame, pending = pending.split(end, 1)
            graphics_seen |= b'\x1b_Ga=T' in frame
            # pyte models text cells only; graphics bytes must not become text.
            frame = re.sub(rb'\x1b_G.*?\x1b\\', b'', frame, flags=re.S)
            stream.feed(decoder.decode(frame + end))
            positions.append((time.monotonic(), top()))

    def settle(seconds=0.08):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            drain(min(0.01, max(0, deadline - time.monotonic())))

    def until(predicate, seconds=5):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if predicate():
                return
            drain()
        raise AssertionError('\n'.join(screen.display) + '\nUnframed output: ' + repr(pending[-2000:]))

    def wheel(button, count=1):
        os.write(fd, f'\x1b[<{button};10;15M'.encode() * count)

    try:
        until(lambda: top() is not None)
        if args.graphics:
            os.write(fd, f'\x1b_Gi={0x534f5045};OK\x1b\\\x1b[6;20;10t'.encode())
            until(lambda: graphics_seen)
        bottom = top()
        wheel(64, 20)
        settle()
        before = top()
        # Deliberately first: the old decoder moves DOWN on both of these.
        wheel(66, 4)
        wheel(67, 4)
        settle()
        assert top() == before, ('horizontal wheel moved vertical viewport', before, top())
        assert before == bottom - 20 * args.speed, ('wheel step', bottom, before)

        # Split a horizontal report in a diagonal upward burst.
        os.write(fd, b'\x1b[<64;10;15M\x1b[<6')
        settle(0.005)
        os.write(fd, b'6;10;15M\x1b[<64;10;15M\x1b[<67;10;15M')
        until(lambda: top() == before - 2 * args.speed)
        before = top()

        # 125 Hz, one second of input. Every displayed position must move up.
        start = len(positions)
        started = time.monotonic()
        for i in range(125):
            wheel(64)
            deadline = started + (i + 1) * 0.008
            while time.monotonic() < deadline:
                drain(min(0.002, deadline - time.monotonic()))
        until(lambda: top() == before - 125 * args.speed)
        during = [p for _, p in positions[start:] if p is not None]
        assert all(a >= b for a, b in zip(during, during[1:])), ('backward jump', during)
        # Cadence is tested with a deterministic clock in scheduler.test.ts;
        # CI host load must not turn this behavioral check into a flaky FPS gate.
        assert len(during) >= 2, ('scrolling never displayed intermediate positions', len(during))

        # Reverse: no delayed upward animation is allowed after the down event.
        before = top()
        start = len(positions)
        reversed_at = time.monotonic()
        wheel(65)
        until(lambda: top() == before + args.speed)
        reverse_ms = (time.monotonic() - reversed_at) * 1000
        settle(0.15)
        assert top() == before + args.speed, ('drift after release', before, top())
        assert all(p is None or p >= before for _, p in positions[start:]), 'old-direction frame after reversal'

        # Clamp at either edge; excess reports must not accumulate as debt.
        wheel(64, 1000)
        until(lambda: top() == 0)
        wheel(64, 100)
        settle()
        wheel(65)
        until(lambda: top() == args.speed)
        wheel(65, 1000)
        until(lambda: top() == bottom)
        wheel(65, 100)
        settle()
        wheel(64)
        until(lambda: top() == bottom - args.speed)

        # Horizontal wheel over the session list must not move its selection.
        os.write(fd, b'/sessions\r')
        settle()
        before_screen = screen.display[:]
        wheel(66)
        wheel(67)
        settle()
        assert screen.display == before_screen, 'horizontal wheel changed session list'
        os.write(fd, b'\x1b')
        settle()
        os.write(fd, b'/quit\r')
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                reaped = True
                assert os.waitstatus_to_exitcode(status) == 0, status
                break
            drain()
        assert reaped, 'TUI did not exit cleanly'
        print(json.dumps(dict(passed=True, graphics=args.graphics, speed=args.speed,
                              burst_events=125, burst_frames=len(during), reversal_ms=round(reverse_ms, 2))))
    finally:
        if not reaped:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(fd)
