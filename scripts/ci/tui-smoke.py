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
        os.environ.update(TERM='xterm-256color', SOPE_GRAPHICS='0', SOPE_API_KEY='', SOPE_MOUSE='1',
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

    def click(x, y):
        # Coordinates are zero-based screen cells; SGR reports are one-based.
        os.write(fd, f'\x1b[<0;{x + 1};{y + 1}M\x1b[<0;{x + 1};{y + 1}m'.encode())

    def until_cursor(x, y):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if (screen.cursor.x, screen.cursor.y) == (x, y):
                return
            drain()
        raise AssertionError(f'Expected cursor {(x, y)}, got {(screen.cursor.x, screen.cursor.y)}\n{text()}')

    def drag(x0, y0, x1, y1):
        os.write(fd, (f'\x1b[<0;{x0 + 1};{y0 + 1}M'
                      f'\x1b[<32;{x1 + 1};{y1 + 1}M'
                      f'\x1b[<0;{x1 + 1};{y1 + 1}m').encode())

    def until_selected(cells, selected=True):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if all(screen.buffer[y][x].reverse == selected for x, y in cells):
                return
            drain()
        raise AssertionError(f'Expected selection={selected} at {cells}\n{text()}')

    def draft(value):
        os.write(fd, b'\x1b[200~' + value.encode() + b'\x1b[201~')

    def clear_draft():
        os.write(fd, b'\x03')
        until('Message sope…')

    try:
        until('You said: hello CI')
        until('tip:', present=False) # Wait for the turn to finish before Ctrl+C clears drafts.
        # Real SGR clicks must reposition the editing cursor, including on the
        # second cell of a wide character. Typing proves the buffer moved too.
        draft('abＨＩcd')
        until('abＨＩcd')
        click(8, 37)
        until_cursor(7, 37)
        os.write(fd, b'X')
        until('abXＨＩcd')
        click(100, 37)
        until_cursor(14, 37)
        os.write(fd, b'!')
        until('abXＨＩcd!')
        clear_draft()

        # A long word wraps at the input's 104-cell width.
        draft('a' * 104 + 'tail')
        until('tail')
        click(7, 36)
        until_cursor(7, 36)
        os.write(fd, b'X')
        until('aaXaaaa')
        clear_draft()

        # Clicking the top of a scrolled input must preserve its viewport.
        draft('\n'.join(f'line-{i:02}' for i in range(12)))
        until('line-11')
        assert 'line-04' in screen.display[30], text()
        click(8, 30)
        until_cursor(8, 30)
        os.write(fd, b'X')
        until('linXe-04')
        assert 'linXe-04' in screen.display[30] and 'line-11' in screen.display[37], text()
        # The input prompt and left padding place the cursor at the row start.
        click(3, 31)
        until_cursor(5, 31)
        os.write(fd, b'Y')
        until('Yline-05')
        clear_draft()

        # Input selection is editable, in either direction, with both delete keys.
        for start, end, key in [(7, 10, b'\x7f'), (10, 7, b'\x1b[3~')]:
            draft('abcdefg')
            until('abcdefg')
            drag(start, 37, end, 37)
            until_selected([(x, 37) for x in range(7, 10)])
            assert not screen.buffer[37][6].reverse and not screen.buffer[37][10].reverse
            os.write(fd, key)
            until('abfg')
            until_cursor(7, 37)
            clear_draft()

        draft('abＨＩcd')
        until('abＨＩcd')
        drag(7, 37, 11, 37)
        until_selected([(x, 37) for x in range(7, 11)])
        draft('Z') # Pasting replaces the selected wide characters.
        until('abZcd')
        drag(7, 37, 8, 37)
        until_selected([(7, 37)])
        os.write(fd, b'Q') # Ordinary typing replaces the selection too.
        until('abQcd')
        drag(7, 37, 10, 37)
        until_selected([(x, 37) for x in range(7, 10)])
        os.write(fd, b'\x1b')
        until_selected([(x, 37) for x in range(7, 10)], selected=False)
        assert 'abQcd' in text()
        clear_draft()

        draft('abc\n\nxyz')
        until('xyz')
        drag(6, 35, 7, 37)
        until_selected([(6, 35), (5, 36), (6, 37)])
        os.write(fd, b'\x1b[3~')
        until('› az')
        clear_draft()

        draft('a' * 104 + 'tail')
        until('tail')
        drag(107, 36, 7, 37)
        until_selected([(107, 36), (108, 36), (5, 37), (6, 37)])
        os.write(fd, b'\x7f')
        until('aail')
        clear_draft()

        draft('\n'.join(f'line-{i:02}' for i in range(12)))
        until('line-11')
        drag(8, 30, 8, 32)
        until_selected([(8, 30), (5, 31), (7, 32)])
        os.write(fd, b'\x7fX')
        until('linXe-06')
        assert 'line-04' not in text() and 'line-05' not in text()
        clear_draft()

        # Hold the button across frames on an exactly full row. The temporary
        # cursor row must not shift the hit coordinates before release.
        draft('a' * 104)
        until_cursor(5, 37)
        until('a' * 104)
        os.write(fd, b'\x1b[<0;8;37M')
        until_cursor(7, 36)
        os.write(fd, b'\x1b[<32;11;37M')
        until_selected([(x, 36) for x in range(7, 10)])
        os.write(fd, b'\x1b[<0;11;37m\x1b[3~X')
        until('aaXaaaa')
        assert 'aaXaaaa' in screen.display[37], text()
        clear_draft()

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
        print('PTY conversation, input clicks and editable selections (wide text, wraps, scrolling), /context, /effort and clean exit passed')
    finally:
        (logs / 'tui-final.txt').write_text(text())
        if not reaped:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(fd)
