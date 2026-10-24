#!/usr/bin/env python3
"""CMake deliberately skips Go when absent; CI must not silently do so."""
import json
import subprocess
import sys

listing = json.loads(subprocess.check_output([
    'ctest', '--test-dir', sys.argv[1], '--show-only=json-v1',
]))
names = {test['name'] for test in listing['tests']}
required = {'pool', 'agent', 'json', 'compact', 'tools', 'runtime', 'durable',
            'embed_shared', 'embed_static', 'embed_go', 'sdk_go'}
assert required <= names, f'Missing CTest cases: {required - names}'
print(f'All {len(required)} required native/Go tests registered')
