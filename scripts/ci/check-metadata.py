#!/usr/bin/env python3
"""Fail early on version drift or accidentally tracked local state."""
import json
from pathlib import Path
import re
import subprocess

header = Path('include/sope.h').read_text()
version = re.search(r'#define SOPE_VERSION_STRING "([\d.]+)"', header)[1]
major, minor, patch = map(int, version.split('.'))
for name, expected in [('MAJOR', major), ('MINOR', minor), ('PATCH', patch)]:
    assert int(re.search(rf'#define SOPE_VERSION_{name}\s+(\d+)', header)[1]) == expected
for path in ['package.json', 'bindings/js/package.json', 'tui/package.json']:
    assert json.loads(Path(path).read_text())['version'] == version, path
ffi = Path('bindings/js/src/ffi.ts').read_text()
assert f'major: {major}, minor: {minor}' in ffi, 'JS ABI drift'
go = Path('bindings/go/sope.go').read_text()
assert f'SOPE_VERSION_MAJOR != {major} || SOPE_VERSION_MINOR != {minor}' in go, 'Go header ABI drift'
assert f'>>8 != 0x{major:02x}{minor:02x}' in go, 'Go runtime ABI drift'
assert f'## {version} ' in Path('CHANGELOG.md').read_text(), 'Missing changelog section'
for name in subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0'):
    if not name:
        continue
    path = Path(name)
    assert not (path.name.startswith('.env') and path.name != '.env.example'), name
    assert path.suffix not in {'.db', '.sqlite', '.sqlite3'}, name
    assert not any(part == 'node_modules' or part == 'dist' or part == 'build' or part.startswith('build-') for part in path.parts), name
print(f'Versions and tracked files OK: {version}')
