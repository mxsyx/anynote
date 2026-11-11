#!/usr/bin/env python3
"""Prevent incomplete, stale or substituted evidence from becoming reviewable."""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
from release import acceptance as a
from release import native as n


class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        root = n.ROOT / 'tmp/rm38/tests'
        root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.root = Path(self.temp.name)
        self.source = {'commit': 'a' * 40, 'tree': 'b' * 40, 'dirty': False, 'cargo_lock_sha256': 'c' * 64}

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')
        return path

    def candidate(self, target='mac-arm64'):
        cfg = n.CONFIG['targets'][target]
        payload = 'Anynote.app' if target.startswith('mac-') else 'Anynote' if target.startswith('win-') else 'Anynote.AppDir'
        manifest = self.write(target + '/' + payload + n.MANIFEST, {
            'format': 'anynote.native-payload.v1', 'app_id': n.CONFIG['app_id'], 'version': n.version(),
            'target': target, 'profile': 'release', 'notebook_schema': n.CONFIG['notebook_schema']})
        suffix = '.dmg' if target.startswith('mac-') else '.exe' if target.startswith('win-') else '.AppImage'
        artifact = self.root / target / ('installer' + suffix)
        artifact.write_bytes(b'synthetic fixture, never real acceptance')
        return self.write(target + '/candidate.json', {
            'format': 'anynote.native-candidate.v1', 'app_id': n.CONFIG['app_id'], 'version': n.version(),
            'target': target, 'source': self.source, 'source_unchanged': True,
            'profile': 'release', 'signature': 'verified', 'ci': {
                'server': 'https://github.com', 'repository': 'fixture/repo', 'run_id': '123', 'attempt': '1',
                'workflow': 'fixture', 'sha': self.source['commit'],
                'runner_os': {'macos': 'macOS', 'windows': 'Windows', 'linux': 'Linux'}[cfg['os']],
                'runner_arch': {'aarch64': 'ARM64', 'x86_64': 'X64'}[cfg['arch']]},
            'payload_manifest_sha256': n.digest(manifest),
            'artifact': {'name': artifact.name, 'sha256': n.digest(artifact), 'size': artifact.stat().st_size},
            'health': {'version': n.version(), 'appId': n.CONFIG['app_id'], 'os': cfg['os'], 'arch': cfg['arch'],
                       'notebookSchema': n.CONFIG['notebook_schema'], 'font': 'passed', 'pdfium': 'passed'},
            'notarizations': [{'subject': s, 'id': s + '-receipt', 'status': 'Accepted'} for s in ['app', 'installer']]})

    def evidence(self, candidates):
        log = self.root / 'log.txt'
        log.write_text('synthetic test report')
        return [{'file': log.name, 'sha256': n.digest(log), 'device': 'test machine', 'corpus': 'test corpus',
                 'command': 'test command', 'result': 'test result', 'reviewer': 'test reviewer',
                 'recorded_at': '2026-11-10T12:00:00+08:00', 'version': n.version(),
                 'commit': self.source['commit'], 'candidate_sha256': [c['sha256'] for c in candidates]}]

    def test_inventory_covers_every_required_boundary(self):
        rows = a.inventory()
        self.assertEqual(len([r for r in rows if r['id'].startswith('OP:')]), 146)
        self.assertEqual(len([r for r in rows if r['id'].startswith('INV-')]), 24)
        self.assertEqual(len([r for r in rows if r['id'].startswith('RM')]), 37)
        self.assertEqual(len(rows), len({r['id'] for r in rows}))
        by_id = {r['id']: r for r in rows}
        self.assertFalse(by_id['F013']['deferable'])
        self.assertTrue(by_id['F032']['deferable'])
        for i in range(22, 31):
            self.assertFalse(by_id[f'F{i:03}']['deferable'])
            self.assertFalse(by_id[f'F{i:03}']['local_complete'])

    def test_empty_bundle_and_checkbox_completion_never_pass(self):
        report = a.evaluate(a.template(), self.root)
        self.assertEqual(report['status'], 'blocked')
        self.assertFalse(report['publication_authorized'])
        self.assertTrue(all(r['status'] == 'blocked' for r in report['records']))

    def test_completed_tasks_keep_candidate_evidence_requirements(self):
        rows = {row['id']: row for row in a.inventory()}
        self.assertTrue(rows['RM01']['local_complete'])
        self.assertFalse(rows['RM19']['local_complete'])
        self.assertFalse(rows['RM37']['local_complete'])
        report = a.evaluate(a.template(), self.root)
        self.assertEqual(next(r for r in report['records'] if r['id'] == 'RM01')['status'], 'blocked')

    def test_incomplete_release_scope_is_rejected(self):
        scope = self.root / 'scope.md'
        scope.write_text('| RM01 | Only one boundary |\n')
        with patch.object(a, 'RELEASE_SCOPE', str(scope)):
            with self.assertRaisesRegex(ValueError, 'release scope incomplete'):
                a.inventory()

    def test_open_group_without_checklist_is_rejected(self):
        todo = self.root / 'TODO.md'
        todo.write_text('### F018 · Retirement\n\nNo checklist\n')
        with patch.object(a, 'TODO', str(todo)):
            with self.assertRaisesRegex(ValueError, 'no actionable checklist'):
                a.inventory()

    def test_removed_task_keeps_fixed_candidate_evidence(self):
        todo = self.root / 'TODO.md'
        content = (n.ROOT / a.TODO).read_text()
        todo.write_text(re.sub(r'<a id="f018"></a>\n.*?(?=<a id="f019">)', '', content, flags=re.S))
        with patch.object(a, 'TODO', str(todo)):
            rows = {row['id']: row for row in a.inventory()}
        self.assertTrue(rows['RM37']['local_complete'])
        self.assertTrue(rows['F018']['local_complete'])
        self.assertFalse(rows['F018']['deferable'])

    def test_required_task_cannot_be_hidden_in_future_or_duplicated(self):
        todo = self.root / 'TODO.md'
        future = self.root / 'FUTURE-TODO.md'
        content = (n.ROOT / a.TODO).read_text()
        section = re.search(r'<a id="f025"></a>\n.*?(?=<a id="f026">)', content, re.S)[0]
        future.write_text((n.ROOT / a.FUTURE_TODO).read_text() + '\n' + section)
        todo.write_text(content)
        with patch.object(a, 'TODO', str(todo)), patch.object(a, 'FUTURE_TODO', str(future)):
            with self.assertRaisesRegex(ValueError, 'duplicate task across'):
                a.inventory()
            todo.write_text(content.replace(section, ''))
            with self.assertRaisesRegex(ValueError, 'required task cannot move to future'):
                a.inventory()

    def test_unknown_task_and_invalid_checklist_are_rejected(self):
        todo = self.root / 'TODO.md'
        for content, message in (
            ('### F999 · Unknown\n\n- [ ] **F999.1** Check\n', 'fixed release scope'),
            ('### F001 · Editor\n\n- [ ] **F002.1** Wrong owner\n', 'invalid task checklist'),
            ('### F001 · Editor\n\n- [ ] **F001.1** One\n- [ ] **F001.1** Duplicate\n', 'invalid task checklist'),
        ):
            todo.write_text(content)
            with self.subTest(content=content), patch.object(a, 'TODO', str(todo)):
                with self.assertRaisesRegex(ValueError, message):
                    a.inventory()

    def test_duplicate_missing_and_unknown_ids_rejected(self):
        for change in ('duplicate', 'missing', 'unknown'):
            bundle = a.template()
            if change == 'duplicate':
                bundle['records'].append(bundle['records'][0])
            elif change == 'missing':
                bundle['records'].pop()
            else:
                bundle['records'][0]['id'] = 'invented'
            self.assertIn('duplicate, missing or unknown', a.evaluate(bundle, self.root)['errors'][-1])

    def test_candidate_hashes_and_identity(self):
        path = self.candidate()
        self.assertEqual(a.candidate(path)['target'], 'mac-arm64')
        original = a.read_json(path)
        for field, value in [('signature', 'unsigned-candidate'), ('profile', 'dev'), ('source_unchanged', False),
                             ('notarizations', []), ('app_id', 'different'), ('ci', None), ('artifact', None)]:
            data = copy.deepcopy(original)
            data[field] = value
            path.write_text(json.dumps(data))
            with self.subTest(field=field), self.assertRaises((ValueError, TypeError)):
                a.candidate(path)
        path.write_text(json.dumps(original))
        (path.parent / original['artifact']['name']).write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'installer hash'):
            a.candidate(path)

    def test_dirty_source_wrong_ci_commit_and_architecture(self):
        path = self.candidate()
        original = a.read_json(path)
        for key, value in [('dirty', True), ('sha', 'd' * 40), ('runner_arch', 'X64')]:
            data = copy.deepcopy(original)
            data['source' if key == 'dirty' else 'ci'][key] = value
            path.write_text(json.dumps(data))
            with self.subTest(key=key), self.assertRaises(ValueError):
                a.candidate(path)

    def test_mixed_candidate_commits_and_duplicate_targets(self):
        paths = [self.candidate(t) for t in n.CONFIG['targets']]
        bundle = a.template()
        bundle['candidates'] = [str(p.relative_to(self.root)) for p in paths]
        data = a.read_json(paths[0])
        data['source']['commit'] = data['ci']['sha'] = 'd' * 40
        paths[0].write_text(json.dumps(data))
        self.assertIn('candidates do not share', a.evaluate(bundle, self.root)['errors'][0])
        bundle['candidates'].append(bundle['candidates'][0])
        self.assertIn('exactly one final candidate', a.evaluate(bundle, self.root)['errors'][0])

    def test_missing_metadata_stale_log_and_wrong_candidate_are_rejected(self):
        candidates = [a.candidate(self.candidate(t)) for t in n.CONFIG['targets']]
        evidence = self.evidence(candidates)
        a.validate_evidence(evidence, self.root, candidates)
        for key, value in [('candidate_sha256', ['0' * 64]), ('commit', '0' * 40), ('sha256', '0' * 64),
                           ('device', ''), ('corpus', ''), ('command', ''), ('reviewer', ''), ('result', ''),
                           ('recorded_at', '2026-11-10T12:00:00'), ('file', '../escape')]:
            modified = copy.deepcopy(evidence)
            modified[0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                a.validate_evidence(modified, self.root, candidates)

    def test_evidence_cannot_traverse_symlink(self):
        if os.name == 'nt':
            self.skipTest('Windows symlink privilege is not assumed')
        (self.root / 'link').symlink_to(n.ROOT, target_is_directory=True)
        with self.assertRaises(ValueError):
            a.relative_file(self.root, 'link/Cargo.toml')

    def test_only_reviewable_and_open_prerequisites_block_even_with_records(self):
        candidates = [a.candidate(self.candidate(t)) for t in n.CONFIG['targets']]
        bundle = a.template()
        bundle['candidates'] = [c['target'] + '/candidate.json' for c in candidates]
        rows = a.inventory()
        for row in bundle['records']:
            row['status'] = 'passed'
            row['evidence'] = self.evidence([c for c in candidates if 'target' not in row or c['target'] == row['target']])
        with patch.object(a, 'inventory', return_value=[dict(r, local_complete=True) for r in rows]):
            report = a.evaluate(bundle, self.root)
        self.assertEqual(report['status'], 'ready-for-review')
        self.assertFalse(report['publication_authorized'])
        self.assertEqual(report['acceptance'], 'human-review-required')
        with patch.object(a, 'inventory', return_value=[dict(r, local_complete=False) if r['id'] == 'RM37' else r for r in rows]):
            self.assertEqual(a.evaluate(bundle, self.root)['status'], 'blocked')
        bundle['records'][0]['status'] = 'deferred'
        with patch.object(a, 'inventory', return_value=[dict(r, local_complete=True) for r in rows]):
            self.assertEqual(a.evaluate(bundle, self.root)['status'], 'blocked')

    def test_cli_blocked_exit_and_no_overwrite(self):
        output = self.root / 'report.json'
        command = [sys.executable, n.ROOT / 'scripts/rust-release-acceptance.py', 'check', '--output', output]
        result = subprocess.run(command, capture_output=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        before = output.read_bytes()
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 1)
        self.assertEqual(output.read_bytes(), before)

    def test_ci_identity_does_not_record_secrets(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'APPLE_APP_SPECIFIC_PASSWORD': 'secret'}, clear=True):
            self.assertNotIn('secret', json.dumps(n.ci_identity()))

    def test_notarization_requires_request_id_and_preserves_public_receipt(self):
        with patch.dict(os.environ, {'ANYNOTE_NOTARY_PROFILE': 'test'}), patch.object(n, 'credentials'), patch.object(n, 'run') as run:
            run.return_value = subprocess.CompletedProcess([], 0, '{"status":"Accepted"}')
            with self.assertRaises(ValueError):
                n.notarize(self.root)
            run.return_value.stdout = '{"status":"Accepted","id":"request-id","secret":"not recorded"}'
            self.assertEqual(n.notarize(self.root), {'status': 'Accepted', 'id': 'request-id'})


if __name__ == '__main__':
    unittest.main()
