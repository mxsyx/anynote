"""Native release invariants shared by packaging, verification and install drills."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import struct
import subprocess
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / 'apps/desktop-rust/native/release.json').read_text())
MANIFEST = '.manifest.json'
FORBIDDEN = re.compile(r'(^|[/_.-])(electron|node|nodejs|node_modules|quickjs|qjs|react|plugin-sdk|extension-host)([/_.-]|$)', re.I)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(argv, **kwargs):
    return subprocess.run([str(a) for a in argv], check=True, **kwargs)


def version():
    rust = tomllib.loads((ROOT / 'Cargo.toml').read_text())['workspace']['package']['version']
    js = json.loads((ROOT / 'package.json').read_text())['version']
    if rust != js or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', rust):
        raise ValueError('Cargo and root package versions must match')
    return rust


def source_identity():
    def git(*args):
        return run(['git', *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    return {'commit': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
            'dirty': bool(git('status', '--porcelain', '--untracked-files=all')),
            'cargo_lock_sha256': hashlib.sha256(run(['git', 'show', 'HEAD:Cargo.lock'], cwd=ROOT,
                                                   capture_output=True).stdout).hexdigest()}


def ci_identity():
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        return None
    return {key: os.environ.get(env, '') for key, env in {
        'server': 'GITHUB_SERVER_URL', 'repository': 'GITHUB_REPOSITORY',
        'run_id': 'GITHUB_RUN_ID', 'attempt': 'GITHUB_RUN_ATTEMPT',
        'workflow': 'GITHUB_WORKFLOW', 'sha': 'GITHUB_SHA',
        'runner_os': 'RUNNER_OS', 'runner_arch': 'RUNNER_ARCH',
    }.items()}


def architecture(path):
    with Path(path).open('rb') as stream:
        header = stream.read(64)
        if header[:4] == b'\x7fELF':
            if header[4:6] != b'\x02\x01':
                raise ValueError('expected 64-bit little-endian ELF')
            machine = struct.unpack_from('<H', header, 18)[0]
            return ('linux', {62: 'x86_64', 183: 'aarch64'}.get(machine))
        if header[:4] == b'\xcf\xfa\xed\xfe':
            machine = struct.unpack_from('<I', header, 4)[0]
            return ('macos', {0x1000007: 'x86_64', 0x100000C: 'aarch64'}.get(machine))
        if header[:2] == b'MZ' and len(header) == 64:
            stream.seek(struct.unpack_from('<I', header, 60)[0])
            pe = stream.read(6)
            if pe[:4] == b'PE\0\0':
                return ('windows', {0x8664: 'x86_64', 0xAA64: 'aarch64'}.get(struct.unpack_from('<H', pe, 4)[0]))
    raise ValueError('not a supported native executable')


def locations(payload, target):
    if target.startswith('mac-'):
        return payload / 'Contents/MacOS/anynote-desktop', payload / 'Contents/Resources'
    if target.startswith('win-'):
        return payload / 'anynote-desktop.exe', payload
    return payload / 'usr/bin/anynote-desktop', payload / 'usr/bin'


def files(payload):
    result = {}
    for path in sorted(payload.rglob('*')):
        rel = path.relative_to(payload).as_posix()
        if path.is_symlink():
            raise ValueError(f'symlink in payload: {rel}')
        if FORBIDDEN.search(rel) or path.suffix.lower() in {'.asar', '.node'}:
            raise ValueError(f'old host in payload: {rel}')
        if path.is_file():
            result[rel] = {'sha256': digest(path), 'size': path.stat().st_size,
                           'executable': bool(path.stat().st_mode & 0o111) if os.name != 'nt' else None}
    return result


def seal(payload, target, pdfium_hash, profile):
    binary, resources = locations(payload, target)
    expected = CONFIG['targets'][target]
    if architecture(binary) != (expected['os'], expected['arch']):
        raise ValueError('binary architecture does not match target')
    report = {'format': 'anynote.native-payload.v1', 'app_id': CONFIG['app_id'],
              'version': version(), 'target': target, 'profile': profile,
              'notebook_schema': CONFIG['notebook_schema'], 'pdfium_sha256': pdfium_hash,
              'binary': binary.relative_to(payload).as_posix(), 'files': files(payload)}
    payload.with_name(payload.name + MANIFEST).write_text(json.dumps(report, indent=2) + '\n')
    return report


def verify(payload, expected_target=None, report=None):
    if report is None:
        report = json.loads(payload.with_name(payload.name + MANIFEST).read_text())
    if report['format'] != 'anynote.native-payload.v1' or report['app_id'] != CONFIG['app_id']:
        raise ValueError('invalid package identity')
    target = report['target']
    if target not in CONFIG['targets'] or expected_target and target != expected_target:
        raise ValueError('wrong target')
    binary, resources = locations(payload, target)
    if report['binary'] != binary.relative_to(payload).as_posix():
        raise ValueError('invalid payload layout')
    if report['notebook_schema'] != CONFIG['notebook_schema']:
        raise ValueError('unsupported notebook schema')
    expected = CONFIG['targets'][target]
    if architecture(binary) != (expected['os'], expected['arch']):
        raise ValueError('invalid executable architecture')
    if files(payload) != report['files']:
        raise ValueError('payload hash, mode or file inventory mismatch')
    if target.startswith('mac-'):
        plist = plistlib.loads((payload / 'Contents/Info.plist').read_bytes())
        if plist['CFBundleIdentifier'] != CONFIG['app_id'] or plist['CFBundleShortVersionString'] != report['version']:
            raise ValueError('bundle identity/version mismatch')
    return report


def clean_env():
    env = dict(os.environ)
    for key in ('ANYNOTE_PDFIUM_DIR', 'ANYNOTE_RUST_STATE_DIR', 'ANYNOTE_USER_DATA_DIR', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'):
        env.pop(key, None)
    return env


def health(payload, report):
    binary, _ = locations(payload, report['target'])
    output = run([binary, '--release-check'], env=clean_env(), capture_output=True, text=True, timeout=60)
    result = json.loads(output.stdout)
    target = CONFIG['targets'][report['target']]
    if (result.get('version'), result.get('appId'), result.get('os'), result.get('arch'), result.get('notebookSchema')) != (
            report['version'], CONFIG['app_id'], target['os'], target['arch'], report['notebook_schema']):
        raise ValueError('binary release identity mismatch')
    if result.get('pdfium') != 'passed' or result.get('font') != 'passed':
        raise ValueError('native resources failed')
    return result


def credential_names(target):
    if target.startswith('mac-'):
        return ['ANYNOTE_MAC_SIGN_IDENTITY', 'ANYNOTE_MAC_TEAM_ID', 'ANYNOTE_NOTARY_PROFILE']
    if target.startswith('win-'):
        return ['ANYNOTE_WIN_CERT_SHA1', 'ANYNOTE_WIN_TIMESTAMP_URL']
    return []


def credentials(target, env=None):
    env = os.environ if env is None else env
    missing = [k for k in credential_names(target) if not env.get(k, '').strip()]
    if missing:
        raise ValueError('missing signing configuration: ' + ', '.join(missing))
    if target.startswith('win-') and (not re.fullmatch('[A-Fa-f0-9]{40}', env['ANYNOTE_WIN_CERT_SHA1']) or
                                      not env['ANYNOTE_WIN_TIMESTAMP_URL'].startswith('https://')):
        raise ValueError('invalid Windows signing configuration')
    if target.startswith('mac-') and (not env['ANYNOTE_MAC_SIGN_IDENTITY'].startswith('Developer ID Application: ') or
                                      not re.fullmatch('[A-Z0-9]{10}', env['ANYNOTE_MAC_TEAM_ID'])):
        raise ValueError('invalid Developer ID identity/team')


def sign(path, target):
    credentials(target)
    if target.startswith('mac-'):
        keychain = ['--keychain', os.environ['ANYNOTE_MAC_KEYCHAIN']] if os.environ.get('ANYNOTE_MAC_KEYCHAIN') else []
        run(['codesign', '--force', '--timestamp', '--options', 'runtime', *keychain, '--sign', os.environ['ANYNOTE_MAC_SIGN_IDENTITY'], path])
        verify_signature(path, target)
    elif target.startswith('win-'):
        run(['signtool', 'sign', '/sha1', os.environ['ANYNOTE_WIN_CERT_SHA1'], '/fd', 'SHA256',
             '/tr', os.environ['ANYNOTE_WIN_TIMESTAMP_URL'], '/td', 'SHA256', path])
        verify_signature(path, target)
    else:
        raise ValueError('Linux release signatures are detached checksums, not Authenticode')


def verify_signature(path, target):
    if target.startswith('mac-'):
        team = os.environ.get('ANYNOTE_MAC_TEAM_ID', '')
        if not re.fullmatch('[A-Z0-9]{10}', team):
            raise ValueError('expected Apple team is required')
        requirement = f'anchor apple generic and certificate leaf[subject.OU] = "{team}"'
        run(['codesign', '--verify', '--deep', '--strict', '-R', requirement, path], capture_output=True)
    elif target.startswith('win-'):
        thumbprint = os.environ.get('ANYNOTE_WIN_CERT_SHA1', '')
        if not re.fullmatch('[A-Fa-f0-9]{40}', thumbprint):
            raise ValueError('expected Windows signer is required')
        run(['signtool', 'verify', '/pa', '/all', path], capture_output=True)
        # Authenticode validity alone does not identify our publisher.
        env = dict(os.environ, ANYNOTE_VERIFY_FILE=str(path), ANYNOTE_VERIFY_SIGNER=thumbprint)
        run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
             '$s=Get-AuthenticodeSignature -LiteralPath $env:ANYNOTE_VERIFY_FILE; '
             'if($s.Status -ne "Valid" -or $s.SignerCertificate.Thumbprint -ne $env:ANYNOTE_VERIFY_SIGNER){exit 1}'], env=env, capture_output=True)
    else:
        raise ValueError('verify the detached release manifest before Linux installation')


def notarize(path):
    credentials('mac-arm64')
    keychain = ['--keychain', os.environ['ANYNOTE_MAC_KEYCHAIN']] if os.environ.get('ANYNOTE_MAC_KEYCHAIN') else []
    result = run(['xcrun', 'notarytool', 'submit', path, *keychain, '--keychain-profile', os.environ['ANYNOTE_NOTARY_PROFILE'],
                  '--wait', '--output-format', 'json'], capture_output=True, text=True, timeout=3600)
    receipt = json.loads(result.stdout)
    if receipt.get('status') != 'Accepted' or not receipt.get('id'):
        raise ValueError('notarization did not return Accepted')
    return {'id': receipt['id'], 'status': receipt['status']}


def install(source, destination, *, allow_unsigned=False, check=health, notebooks=()):
    """Manual directory install; retain previous version, never migrate/delete user data.

    The sibling lock also protects crash evidence. Interrupted installs are refused
    until an operator inspects the retained previous/candidate directories.
    """
    if source.is_symlink():
        raise ValueError('source cannot be a symlink')
    source, destination = source.resolve(), destination.absolute()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError('source and installation must be separate')
    if destination.is_symlink():
        raise ValueError('installation destination cannot be a symlink')
    report = verify(source)
    if not allow_unsigned:
        verify_signature(source if report['target'].startswith('mac-') else locations(source, report['target'])[0], report['target'])
    destination.parent.mkdir(parents=True, exist_ok=True)
    lock = destination.with_name(destination.name + '.install-lock')
    previous = destination.with_name(destination.name + '.previous')
    failed = destination.with_name(destination.name + '.failed')
    manifest = destination.with_name(destination.name + MANIFEST)
    previous_manifest = previous.with_name(previous.name + MANIFEST)
    failed_manifest = failed.with_name(failed.name + MANIFEST)
    if manifest.is_symlink() or (manifest.exists() and not destination.exists()):
        raise ValueError('orphaned or symlink installation manifest')
    if failed.exists() or failed_manifest.exists():
        raise ValueError('failed installation retained; inspect it before retrying')
    if previous.exists() or previous_manifest.exists():
        raise ValueError('previous installation retained; archive it before another upgrade')
    lock.mkdir()
    stage = None
    stage_manifest = None
    manifest_moved = False
    manifest_installed = False
    moved = False
    installed = False
    recovery_failed = False
    try:
        stage = Path(tempfile.mkdtemp(prefix=destination.name + '.candidate.', dir=destination.parent))
        shutil.copytree(source, stage, dirs_exist_ok=True)
        verify(stage, report['target'], report)
        stage_manifest = stage.with_name(stage.name + MANIFEST)
        with stage_manifest.open('x') as stream:
            stream.write(json.dumps(report, indent=2) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        check(stage, report)
        binary = locations(stage, report['target'])[0]
        for notebook in notebooks:
            run([binary, '--check-notebook', Path(notebook).resolve()], env=clean_env(), capture_output=True, timeout=120)
        if destination.exists():
            destination.rename(previous)
            moved = True
        if manifest.exists():
            manifest.rename(previous_manifest)
            manifest_moved = True
        stage.rename(destination)
        stage = None
        installed = True
        stage_manifest.rename(manifest)
        manifest_installed = True
        stage_manifest = None
        check(destination, report)
    except BaseException:
        try:
            if installed:
                destination.rename(failed)
            if manifest_installed:
                manifest.rename(failed_manifest)
            if moved:
                previous.rename(destination)
            if manifest_moved:
                previous_manifest.rename(manifest)
        except OSError:
            recovery_failed = True
            raise RuntimeError('rollback failed; retained directories and install lock require manual recovery') from None
        raise
    finally:
        if stage and stage.exists():
            shutil.rmtree(stage)
        if stage_manifest and stage_manifest.exists():
            stage_manifest.unlink()
        if not recovery_failed:
            lock.rmdir()
    return {'status': 'installed', 'version': report['version'], 'previous': str(previous) if moved else None, 'user_data': 'untouched'}
