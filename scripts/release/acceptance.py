"""RM38 evidence completeness checks, never publication or an acceptance oracle."""
from datetime import datetime
import json
from pathlib import Path
import re

from . import native as n

TODO = 'docs/development/TODO.md'
RELEASE_SCOPE = 'docs/design/RUST-RELEASE-SCOPE.md'
OPERATIONS = 'tests/fixtures/rust-migration/inventory/operations.json'
INVARIANTS = 'scripts/rust-regression-invariants.json'
PLATFORM_CHECKS = ('ci', 'signature', 'install', 'offline-first-use', 'uninstall-preserves-data',
                   'upgrade', 'failed-upgrade-rollback', 'schema-rejection', 'package-identity')
FINAL_CHECKS = ('scope-decision', 'user-script-inventory', 'full-functionality',
                'takeover-rehearsal', 'latest-data-rollback', 'release-runbook')
# Future work is not an exemption for migrated functionality.
DEFERABLE = {'A009'} | {f'F{i:03}' for i in range(9, 25) if i not in (11, 20)}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def inventory(root=n.ROOT):
    todo = (root / TODO).read_text(encoding='utf-8')
    scope = (root / RELEASE_SCOPE).read_text(encoding='utf-8')
    required = re.findall(r'^\|\s*(RM\d{2})\s*\|\s*([^|\n]+)\s*\|\s*$', scope, re.M)
    require(len(required) == 37 and {key for key, _ in required} == {f'RM{i:02}' for i in range(1, 38)},
            'RM01–37 release scope incomplete')
    # Removing completed TODOs never removes their final-candidate evidence checks.
    rms = {key: {'title': title.strip(), 'local_complete': True} for key, title in required}
    sections = re.findall(r'^#### (RM\d{2}) · ([^\n]+)\n(.*?)(?=^<a id=|^### |\Z)',
                          todo, re.M | re.S)
    require(len(sections) == len({key for key, _, _ in sections}), 'duplicate RM task')
    for key, title, body in sections:
        require(key in rms or key == 'RM38', 'unknown RM task')
        boxes = re.findall(r'^- \[([ x])\] \*\*' + key + r'\.\d+\*\*', body, re.M)
        require(bool(boxes), 'RM task has no actionable checklist')
        if key == 'RM38':
            continue
        rms[key]['local_complete'] = all(x == 'x' for x in boxes)
    ops = read_json(root / OPERATIONS)
    inv = read_json(root / INVARIANTS)
    require(len(ops) == 146 and len({x['operation'] for x in ops}) == 146, 'expected 146 distinct operations')
    require(len(inv) == 24 and {x['id'] for x in inv} == {f'INV-{i:02}' for i in range(1, 25)}, 'INV-01–24 inventory incomplete')
    legacy = dict(re.findall(r'^### ([VAF]\d{3}) · ([^\n]+)', todo, re.M))
    require({'A011', 'F007', 'F008', 'V010', 'V011'} <= legacy.keys(), 'legacy release scope missing')
    rows = [{'id': k, **v} for k, v in rms.items()]
    rows += [{'id': x['id'], 'remaining': x['remaining'], 'tests': x['tests']} for x in inv]
    rows += [{'id': 'OP:' + x['operation'], 'owner': x['owner'], 'disposition': x['disposition']} for x in ops]
    rows += [{'id': k, 'title': v, 'deferable': k in DEFERABLE} for k, v in legacy.items()]
    rows += [{'id': key} for key in FINAL_CHECKS]
    for target in n.CONFIG['targets']:
        checks = PLATFORM_CHECKS + (('notarization',) if target.startswith('mac-') else ())
        rows += [{'id': f'{target}:{check}', 'target': target} for check in checks]
    return rows


def template(root=n.ROOT):
    return {'format': 'anynote.release-evidence.v1', 'version': n.version(),
            'candidates': [], 'records': [dict(row, status='not-run', reason='Awaiting final-candidate evidence', evidence=[])
                                        for row in inventory(root)]}


def relative_file(base, name):
    require(isinstance(name, str) and bool(name), 'missing evidence file path')
    path = base / name
    require(not Path(name).is_absolute() and '..' not in Path(name).parts, 'file must be inside evidence bundle')
    require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(base.resolve()), 'missing/unsafe evidence file')
    return path


def candidate(path):
    data = read_json(path)
    target = data['target']
    require(target in n.CONFIG['targets'], 'unknown candidate target')
    require(data['format'] == 'anynote.native-candidate.v1', 'invalid candidate format')
    require(data.get('app_id') == n.CONFIG['app_id'] and data['version'] == n.version(), 'candidate identity/version mismatch')
    source = data['source']
    require(re.fullmatch('[0-9a-f]{40}', source['commit']) and re.fullmatch('[0-9a-f]{40}', source['tree']), 'invalid source identity')
    require(source['dirty'] is False and data['source_unchanged'] is True, 'dirty or changed build source')
    require(re.fullmatch('[0-9a-f]{64}', source['cargo_lock_sha256']), 'missing lock identity')
    require(data['profile'] == 'release' and data['signature'] == 'verified', 'release profile and real signature required')
    ci = data['ci']
    require(isinstance(ci, dict) and all(isinstance(v, str) and v for v in ci.values()), 'hosted CI identity missing')
    require(ci['server'].startswith('https://') and re.fullmatch(r'[^/]+/[^/]+', ci['repository']) and
            ci['run_id'].isdigit() and ci['attempt'].isdigit() and ci['sha'] == source['commit'], 'CI/source mismatch')
    cfg = n.CONFIG['targets'][target]
    require(ci['runner_os'] == {'macos': 'macOS', 'windows': 'Windows', 'linux': 'Linux'}[cfg['os']] and
            ci['runner_arch'] == {'aarch64': 'ARM64', 'x86_64': 'X64'}[cfg['arch']], 'CI runner target mismatch')
    payload_name = 'Anynote.app' if target.startswith('mac-') else 'Anynote' if target.startswith('win-') else 'Anynote.AppDir'
    manifest_path = relative_file(path.parent, payload_name + n.MANIFEST)
    require(n.digest(manifest_path) == data['payload_manifest_sha256'], 'payload manifest hash mismatch')
    manifest = read_json(manifest_path)
    require(manifest['format'] == 'anynote.native-payload.v1' and manifest['app_id'] == data['app_id'] and
            manifest['version'] == data['version'] and manifest['target'] == target and
            manifest['profile'] == 'release' and manifest['notebook_schema'] == n.CONFIG['notebook_schema'], 'payload identity mismatch')
    artifact = data['artifact']
    package = relative_file(path.parent, artifact['name'])
    suffix = '.dmg' if target.startswith('mac-') else '.exe' if target.startswith('win-') else '.AppImage'
    require(package.suffix == suffix and package.stat().st_size > 0 and
            n.digest(package) == artifact['sha256'] and package.stat().st_size == artifact['size'], 'installer hash/size/type mismatch')
    health = data['health']
    require(all(health.get(k) == v for k, v in {'version': data['version'], 'appId': data['app_id'],
            'os': cfg['os'], 'arch': cfg['arch'], 'notebookSchema': n.CONFIG['notebook_schema'],
            'font': 'passed', 'pdfium': 'passed'}.items()), 'packaged health incomplete')
    if target.startswith('mac-'):
        receipts = data['notarizations']
        require(len(receipts) == 2 and {r['subject'] for r in receipts} == {'app', 'installer'} and
                all(r['id'] and r['status'] == 'Accepted' for r in receipts), 'real app and installer notarization receipts required')
    return {'target': target, 'sha256': n.digest(path), 'source': source, 'version': data['version'],
            'ci_run': f"{ci['server']}/{ci['repository']}/actions/runs/{ci['run_id']}/attempts/{ci['attempt']}"}


def validate_evidence(evidence, base, candidates, target=None):
    require(isinstance(evidence, list) and evidence, 'supporting evidence missing')
    selected = [c for c in candidates if target is None or c['target'] == target]
    require(len(selected) == (len(n.CONFIG['targets']) if target is None else 1), 'candidate set incomplete')
    expected = sorted(c['sha256'] for c in selected)
    for item in evidence:
        require(isinstance(item, dict), 'invalid evidence record')
        for key in ('device', 'corpus', 'command', 'result', 'reviewer', 'recorded_at'):
            require(isinstance(item.get(key), str) and item[key].strip(), f'evidence {key} missing')
        require(datetime.fromisoformat(item['recorded_at']).tzinfo is not None, 'evidence time needs timezone')
        require(item.get('version') == n.version() and item.get('commit') == selected[0]['source']['commit'], 'stale evidence source/version')
        require(sorted(item.get('candidate_sha256', [])) == expected, 'evidence is not bound to exact candidate set')
        path = relative_file(base, item.get('file'))
        require(path.stat().st_size > 0 and n.digest(path) == item.get('sha256'), 'evidence hash mismatch/empty log')


def evaluate(bundle, base, root=n.ROOT):
    require(bundle.get('format') == 'anynote.release-evidence.v1', 'invalid evidence bundle format')
    require(bundle.get('version') == n.version(), 'evidence bundle version mismatch')
    errors, candidates = [], []
    for name in bundle.get('candidates', []):
        try:
            candidates.append(candidate(relative_file(base, name)))
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append(f'candidate {name}: {error}')
    targets = [c['target'] for c in candidates]
    if sorted(targets) != sorted(n.CONFIG['targets']):
        errors.append('exactly one final candidate per configured target is required')
    if candidates and any(c['source'] != candidates[0]['source'] for c in candidates):
        errors.append('candidates do not share the same clean commit/tree/lock')
    expected = inventory(root)
    records = bundle.get('records', [])
    require(isinstance(records, list) and all(isinstance(r, dict) and isinstance(r.get('id'), str) for r in records), 'invalid records')
    by_id = {r['id']: r for r in records}
    if len(by_id) != len(records) or set(by_id) != {r['id'] for r in expected}:
        errors.append('duplicate, missing or unknown evidence IDs; regenerate inventory')
    results = []
    for required in expected:
        key = required['id']
        row = by_id.get(key, {})
        problems = []
        if required.get('local_complete') is False:
            problems.append('TODO implementation/acceptance prerequisites remain open')
        status = row.get('status', 'not-run')
        if status != 'passed' and not (status == 'deferred' and required.get('deferable')):
            problems.append(f"{status}: {row.get('reason', 'evidence missing')}")
        else:
            try:
                if status == 'deferred':
                    require(isinstance(row.get('reason'), str) and row['reason'].strip(), 'deferral reason missing')
                validate_evidence(row.get('evidence'), base, candidates, required.get('target'))
            except (OSError, ValueError, KeyError, TypeError) as error:
                problems.append(str(error))
        results.append({**required, 'recorded_status': status, 'status': 'blocked' if problems else 'reviewable', 'problems': problems})
    blocked = bool(errors) or any(r['problems'] for r in results)
    return {'format': 'anynote.release-review.v1', 'status': 'blocked' if blocked else 'ready-for-review',
            'publication_authorized': False, 'acceptance': 'human-review-required',
            'version': n.version(), 'inputs': {p: n.digest(root / p) for p in (TODO, OPERATIONS, INVARIANTS)},
            'candidates': candidates, 'errors': errors, 'records': results}
