#!/usr/bin/env python3
"""Run macOS leak diagnostics in disposable process groups, with bounded cleanup."""
import os
from pathlib import Path
import signal
import subprocess
import sys

for executable in sys.argv[1:]:
    process = subprocess.Popen(['leaks', '--atExit', '--', str(Path(executable).resolve())],
                               start_new_session=True)
    try:
        code = process.wait(timeout=90)
        if code:
            raise subprocess.CalledProcessError(code, process.args)
    finally:
        # Diagnostic helpers and test shells must not survive the test and
        # interfere with the Actions runner's end-of-job process inspection.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
