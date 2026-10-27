#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Exercise diagram viewports in a real TUI PTY with a throwaway transcript (requires pyte)."""
import argparse
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
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
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
bun = shutil.which('bun')
command = [str(args.executable.resolve())] if args.executable else [bun, str(root / 'tui/src/main.ts')]
command += ['--provider', 'mock']
diagram = '\n'.join(['┌' + '─' * 120 + '┐',
                      '│ LEFT' + ' ' * 99 + 'RIGHT-HIDDEN   │',
                      '└' + '─' * 120 + '┘'])
small = '┌────────┐\n│ ACTOR │\n└────────┘'
text = '\n'.join(f'row-{i:03}' for i in range(45)) + '\n\n' + diagram + '\n\nANCHOR\n\n' + small
with tempfile.TemporaryDirectory(prefix='sope-diagram-') as scratch:
    directory = str(Path(scratch).resolve())
    db = f'{directory}/session.db'
    seed = f'''
      import {{ Store }} from {json.dumps(str(root / 'tui/src/store.ts'))};
      const store = new Store(process.argv[1]);
      store.create('diagram-fixture', process.cwd(), 'diagram fixture');
      store.save('diagram-fixture', {{title:'diagram fixture', tokensIn:0, tokensOut:0, context:0}},
        new Map([[0, {{role:'assistant', text:{json.dumps(text)}}}]]), 1);
      store.close();
    '''
    subprocess.run([bun, '-e', seed, db], cwd=directory, check=True)
    pid, fd = pty.fork()
    if pid == 0:
        library = os.environ.get('SOPE_LIB')
        for key in list(os.environ):
            if key.startswith('SOPE_'):
                del os.environ[key]
        if library and not args.executable:
            os.environ['SOPE_LIB'] = library
        os.environ.update(TERM='xterm-256color', SOPE_API_KEY='', SOPE_DB=db,
                          SOPE_MOUSE='1', SOPE_SCROLL_SPEED='1', SOPE_GRAPHICS='0',
                          XDG_CONFIG_HOME=f'{directory}/config')
        os.chdir(directory)
        os.execv(command[0], command)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 92, 0, 0))
    screen = pyte.Screen(92, 40)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder('utf8')('replace')
    reaped = False

    def drain():
        if select.select([fd], [], [], 0.02)[0]:
            try:
                stream.feed(decoder.decode(os.read(fd, 65536)))
            except OSError:
                pass

    def until(predicate):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if predicate():
                return
            drain()
        raise AssertionError('\n'.join(screen.display))

    def settle():
        end = time.monotonic() + 0.15
        while time.monotonic() < end:
            drain()

    def line(needle):
        return next(i for i, row in enumerate(screen.display) if needle in row)

    def wheel(button, y, count):
        os.write(fd, f'\x1b[<{button};12;{y + 1}M'.encode() * count)

    def click(x, y):
        os.write(fd, f'\x1b[<0;{x + 1};{y + 1}M\x1b[<0;{x + 1};{y + 1}m'.encode())

    try:
        until(lambda: any('│ ACTOR  │' in row for row in screen.display))
        y = line('LEFT')
        anchor = line('ANCHOR')
        actor = line('ACTOR')
        wheel(67, y, 200)
        until(lambda: 'RIGHT-HIDDEN' in screen.display[y])
        assert line('ANCHOR') == anchor and line('ACTOR') == actor
        assert '│ ACTOR  │' in screen.display[actor]
        wheel(66, y, 200)
        until(lambda: 'LEFT' in screen.display[y])
        # Shift+vertical wheel is a horizontal gesture inside the diagram only.
        wheel(69, y, 200)
        until(lambda: 'RIGHT-HIDDEN' in screen.display[y])
        assert line('ANCHOR') == anchor
        click(20, actor + 2)
        until(lambda: '│ ACTOR │' in screen.display[actor])
        click(20, actor + 2)
        until(lambda: '│ ACTOR  │' in screen.display[actor])
        before = list(screen.display)
        wheel(67, anchor, 5)
        settle()
        assert screen.display == before, 'Horizontal reports outside diagrams changed the view'
        wheel(64, y, 2)
        until(lambda: line('ANCHOR') == anchor + 2)
        wheel(65, y, 2)
        until(lambda: line('ANCHOR') == anchor)
        # Resize retains row count; horizontal clipping is recomputed.
        screen.resize(40, 72)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 72, 0, 0))
        os.kill(pid, signal.SIGWINCH)
        until(lambda: any('ACTOR' in row for row in screen.display) and line('ANCHOR') == anchor)
        settle()
        assert line('ANCHOR') == anchor and line('ACTOR') == actor
        os.write(fd, b'/quit\r')
        end = time.monotonic() + 5
        while time.monotonic() < end:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                reaped = True
                assert os.waitstatus_to_exitcode(status) == 0
                break
            drain()
        else:
            raise AssertionError('TUI did not exit')
        print('PTY diagram horizontal/shift wheel, vertical scrolling, original toggle, resize and clean exit passed')
    finally:
        if not reaped:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(fd)
