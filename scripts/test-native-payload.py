#!/usr/bin/env python3
"""Exercise the built candidate without starting a window or opening user data."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
from release import native as n

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('payload', type=Path)
args = parser.parse_args()
source = args.payload.resolve()
report = n.verify(source)
checks = {'payload': n.health(source, report)}
with tempfile.TemporaryDirectory(prefix='package-check.', dir=n.ROOT / 'tmp/rm36') as temporary:
    root = Path(temporary)
    data = root / 'user-data'
    data.mkdir()
    (data / 'sentinel').write_text('latest user edits')
    before = n.digest(data / 'sentinel')
    destination = root / source.name
    checks['install'] = n.install(source, destination, allow_unsigned=True)['status']
    checks['upgrade'] = n.install(source, destination, allow_unsigned=True)['status']
    assert destination.with_name(destination.name + '.previous').is_dir()
    assert before == n.digest(data / 'sentinel')
    checks['user_data'] = 'unchanged'
    notebook = root / 'notebook'
    shutil.copytree(n.ROOT / 'tests/fixtures/rust-migration/corpus/notebook', notebook)
    binary, resources = n.locations(destination, report['target'])
    n.run([binary, '--check-notebook', notebook], env=n.clean_env(), capture_output=True)
    with sqlite3.connect(notebook / 'notebook.sqlite') as db:
        db.execute('UPDATE notebook_meta SET schema_version=999')
    before = n.digest(notebook / 'notebook.sqlite')
    result = subprocess.run([binary, '--check-notebook', notebook], env=n.clean_env(), capture_output=True)
    assert result.returncode != 0
    assert n.digest(notebook / 'notebook.sqlite') == before
    checks['future_schema'] = 'rejected_without_write'
    with binary.open('ab') as stream:
        stream.write(b'corruption')
    try:
        n.verify(destination)
    except ValueError:
        checks['tamper_scan'] = 'rejected'
    else:
        raise AssertionError('modified executable was accepted')
    if report['target'].startswith('mac-'):
        result = subprocess.run(['codesign', '--verify', '--deep', '--strict', destination], capture_output=True)
        assert result.returncode != 0
        checks['tamper_signature'] = 'rejected'
output = source.parent / 'payload-tests.json'
output.write_text(json.dumps(checks, indent=2) + '\n')
print(json.dumps(checks, indent=2))
