#!/usr/bin/env python3
"""Failure-path regressions for native payloads and manual directory upgrades."""
import copy
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from release import native as n


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        root = n.ROOT / 'tmp/rm36/tests'
        root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.root = Path(self.temp.name)
        self.payload = self.root / 'source'
        self.binary, self.resources = n.locations(self.payload, 'linux-x64')
        self.binary.parent.mkdir(parents=True)
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<H', header, 18, 62)
        self.binary.write_bytes(header)
        self.binary.chmod(0o755)
        (self.resources / 'LICENSE').write_text('test notice')
        self.report = n.seal(self.payload, 'linux-x64', 'dev')
        self.destination = self.root / 'installed'

    def tearDown(self):
        self.temp.cleanup()

    def test_payload_integrity_and_abi(self):
        n.verify(self.payload)
        with self.binary.open('ab') as stream:
            stream.write(b'tampered')
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            n.verify(self.payload)

    def test_wrong_architecture_and_schema(self):
        with self.assertRaisesRegex(ValueError, 'wrong target'):
            n.verify(self.payload, 'win-x64')
        report = copy.deepcopy(self.report)
        report['notebook_schema'] = 999
        with self.assertRaisesRegex(ValueError, 'schema'):
            n.verify(self.payload, report=report)
        self.binary.write_bytes(b'not a binary')
        with self.assertRaisesRegex(ValueError, 'native executable'):
            n.verify(self.payload)

    def test_old_host_added_file_and_symlink_rejected(self):
        for name in ['electron', 'node.exe', 'app.asar', 'quickjs.dll']:
            path = self.resources / name
            path.write_bytes(b'not allowed')
            with self.assertRaisesRegex(ValueError, 'old host'):
                n.verify(self.payload)
            path.unlink()
        path = self.resources / 'extra'
        path.write_text('extra')
        with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
            n.verify(self.payload)
        path.unlink()
        if os.name != 'nt':
            path.symlink_to(self.binary)
            with self.assertRaisesRegex(ValueError, 'symlink'):
                n.verify(self.payload)

    def test_credentials_fail_closed(self):
        for target in ['mac-arm64', 'win-x64']:
            with self.assertRaisesRegex(ValueError, 'missing signing'):
                n.credentials(target, {})
        with self.assertRaisesRegex(ValueError, 'invalid Windows'):
            n.credentials('win-x64', {'ANYNOTE_WIN_CERT_SHA1': 'bad', 'ANYNOTE_WIN_TIMESTAMP_URL': 'http://example.invalid'})

    def test_signature_failure_is_fatal_before_install(self):
        self.destination.mkdir()
        (self.destination / 'old').write_text('retained')
        with patch.object(n, 'verify_signature', side_effect=ValueError('invalid signature')):
            with self.assertRaisesRegex(ValueError, 'signature'):
                n.install(self.payload, self.destination)
        self.assertEqual((self.destination / 'old').read_text(), 'retained')
        self.assertFalse(self.destination.with_name('installed.previous').exists())

    def test_signing_checks_identity_and_notarization_status(self):
        env = {'ANYNOTE_MAC_SIGN_IDENTITY': 'Developer ID Application: Test (ABCDEFGHIJ)',
               'ANYNOTE_MAC_TEAM_ID': 'ABCDEFGHIJ', 'ANYNOTE_NOTARY_PROFILE': 'test'}
        with patch.dict(os.environ, env, clear=True), patch.object(n, 'run') as run:
            n.sign(self.binary, 'mac-arm64')
            self.assertIn('--timestamp', run.call_args_list[0].args[0])
            self.assertIn('anchor apple generic and certificate leaf[subject.OU] = "ABCDEFGHIJ"', run.call_args_list[1].args[0])
            run.return_value = subprocess.CompletedProcess([], 0, '{"status":"Invalid"}')
            with self.assertRaisesRegex(ValueError, 'Accepted'):
                n.notarize(self.binary)
        with patch.dict(os.environ, env, clear=True), patch.object(n, 'run', side_effect=subprocess.CalledProcessError(1, 'codesign')):
            with self.assertRaises(subprocess.CalledProcessError):
                n.sign(self.binary, 'mac-arm64')

    def test_install_upgrade_preserves_previous_and_user_data(self):
        self.destination.mkdir()
        (self.destination / 'old').write_text('retained')
        data = self.root / 'user-data'
        data.mkdir()
        (data / 'notebook').write_text('latest edits')
        n.install(self.payload, self.destination, allow_unsigned=True, check=lambda *_: None)
        self.assertEqual((self.root / 'installed.previous/old').read_text(), 'retained')
        self.assertEqual((data / 'notebook').read_text(), 'latest edits')
        n.verify(self.destination)
        with self.assertRaisesRegex(ValueError, 'previous installation retained'):
            n.install(self.payload, self.destination, allow_unsigned=True, check=lambda *_: None)

    def test_preflight_failure_never_moves_previous(self):
        self.destination.mkdir()
        (self.destination / 'old').write_text('retained')
        def fail(*_):
            raise ValueError('missing runtime')
        with self.assertRaisesRegex(ValueError, 'missing runtime'):
            n.install(self.payload, self.destination, allow_unsigned=True, check=fail)
        self.assertEqual((self.destination / 'old').read_text(), 'retained')
        self.assertFalse(self.root.joinpath('installed.previous').exists())

    def test_post_switch_failure_restores_previous(self):
        self.destination.mkdir()
        (self.destination / 'old').write_text('retained')
        def fail_after_switch(path, _):
            if path == self.destination:
                raise ValueError('startup failed')
        with self.assertRaisesRegex(ValueError, 'startup failed'):
            n.install(self.payload, self.destination, allow_unsigned=True, check=fail_after_switch)
        self.assertEqual((self.destination / 'old').read_text(), 'retained')
        self.assertTrue(self.root.joinpath('installed.failed/usr/bin/anynote-desktop').exists())

    def test_post_switch_failure_restores_matching_manifest(self):
        n.install(self.payload, self.destination, allow_unsigned=True, check=lambda *_: None)
        old_manifest = self.destination.with_name(self.destination.name + n.MANIFEST).read_bytes()
        def fail(path, _):
            if path == self.destination:
                raise ValueError('post-switch failure')
        with self.assertRaisesRegex(ValueError, 'post-switch failure'):
            n.install(self.payload, self.destination, allow_unsigned=True, check=fail)
        n.verify(self.destination)
        self.assertEqual(old_manifest, self.destination.with_name(self.destination.name + n.MANIFEST).read_bytes())
        self.assertTrue(self.root.joinpath('installed.failed.manifest.json').exists())

    def test_rename_failure_preserves_old_install(self):
        self.destination.mkdir()
        (self.destination / 'old').write_text('retained')
        with patch.object(Path, 'rename', side_effect=PermissionError('locked')):
            with self.assertRaises(PermissionError):
                n.install(self.payload, self.destination, allow_unsigned=True, check=lambda *_: None)
        self.assertEqual((self.destination / 'old').read_text(), 'retained')

    def test_interrupted_install_lock_is_not_overwritten(self):
        self.root.joinpath('installed.install-lock').mkdir()
        with self.assertRaises(FileExistsError):
            n.install(self.payload, self.destination, allow_unsigned=True, check=lambda *_: None)

    def test_schema_preflight_failure_never_switches(self):
        self.destination.mkdir()
        (self.destination / 'old').write_text('retained')
        with patch.object(n, 'run', side_effect=subprocess.CalledProcessError(1, 'check-notebook')):
            with self.assertRaises(subprocess.CalledProcessError):
                n.install(self.payload, self.destination, allow_unsigned=True, check=lambda *_: None, notebooks=[self.root / 'future'])
        self.assertEqual((self.destination / 'old').read_text(), 'retained')


if __name__ == '__main__':
    unittest.main()
