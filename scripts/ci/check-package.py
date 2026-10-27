#!/usr/bin/env python3
"""Check the actual archive, then install and run it outside the checkout."""
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile

archive = Path(sys.argv[1]).resolve()
expected = archive.with_suffix(archive.suffix + '.sha256').read_text().split()
assert expected[1] == archive.name, 'Checksum names a different archive'
assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected[0], 'Checksum mismatch'
name = archive.name.removesuffix('.tar.gz')
version = re.fullmatch(r'sope-([0-9]+\.[0-9]+\.[0-9]+)-(darwin|linux)-(arm64|x64)', name)[1]
with tempfile.TemporaryDirectory(prefix='sope-package-') as scratch:
    root = Path(scratch)
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            assert not path.is_absolute() and '..' not in path.parts, member.name
            assert path.parts[0] == name, member.name
            assert member.isfile() or member.isdir() or member.issym(), member.name
            assert not (path.name.startswith('.env') and path.name != '.env.example'), member.name
            assert not path.name.endswith(('.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3')), member.name
            assert not any(part in {'.git', 'node_modules'} for part in path.parts), member.name
            if member.issym():
                target = PurePosixPath(member.linkname)
                assert not target.is_absolute() and '..' not in target.parts, member.name
        tar.extractall(root, filter='data')
    package = root / name
    for relative in ['bin/sope', 'lib/libsope.a', 'include/sope.h', 'LICENSE',
                     'licenses/sqlite.txt', 'README.md', 'CHANGELOG.md',
                     'install.sh']:
        assert (package / relative).is_file(), relative
    # Look for tokens in packaged text; the scanner never needs a real credential.
    subprocess.run(['gitleaks', 'dir', str(package), '--redact=100', '--no-banner'], check=True)
    env = os.environ.copy()
    env.pop('SOPE_LIB', None)
    env.pop('SOPE_API_KEY', None)
    env.update(XDG_CONFIG_HOME=str(root / 'config'), XDG_DATA_HOME=str(root / 'data'),
               SOPE_DB=str(root / 'smoke.db'), SOPE_GRAPHICS='0')
    prefix = root / 'installed'
    subprocess.run([str(package / 'install.sh'), '--prefix', str(prefix), '--lib'],
                   env=env, check=True, timeout=30)
    executable = str(prefix / 'bin/sope')
    output = subprocess.check_output([executable, '--version'], cwd='/', env=env, timeout=15).decode()
    assert f'sope {version} ' in output and 'libsope embedded' in output, output
    print(output.strip())
    output = subprocess.check_output([executable, '--provider', 'mock', '-p', 'package smoke'],
                                    cwd='/', env=env, timeout=30, stdin=subprocess.DEVNULL).decode()
    assert 'You said: package smoke' in output, output
print(f'Archive, installation and embedded executable OK: {archive.name}')
