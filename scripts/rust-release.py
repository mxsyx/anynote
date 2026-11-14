#!/usr/bin/env python3
"""Build/scan native candidates. No publishing and no Electron/Node build dependency."""
import argparse
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import re
import tomllib
import time
import urllib.request

from release import native as n


def notices(output, target):
    metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--locked', '--offline',
                          '--format-version', '1', '--filter-platform', target], cwd=n.ROOT))
    nodes = {row['id']: row for row in metadata['resolve']['nodes']}
    packages = {row['id']: row for row in metadata['packages']}
    desktop = next(p['id'] for p in packages.values() if p['name'] == 'anynote-desktop')
    selected, pending = set(), [desktop]
    while pending:
        key = pending.pop()
        if key in selected:
            continue
        selected.add(key)
        pending.extend(d['pkg'] for d in nodes[key]['deps'] if any(k['kind'] != 'dev' for k in d['dep_kinds']))
    supplements_dir = n.ROOT / 'apps/desktop-rust/native/notices'
    supplements = {row['package']: row for row in json.loads((supplements_dir / 'index.json').read_text())}
    locks = {(p['name'], p['version']): p.get('checksum') for p in tomllib.loads((n.ROOT / 'Cargo.lock').read_text())['package']}
    inventory = []
    output.mkdir(parents=True)
    for key in sorted(selected):
        package = packages[key]
        if not package['license'] and not package['license_file']:
            raise ValueError('dependency lacks license metadata: ' + package['name'])
        directory = Path(package['manifest_path']).parent
        dest = output / (package['name'] + '-' + package['version'])
        dest.mkdir()
        copied = []
        candidates = [p for p in directory.iterdir() if p.is_file() and p.name.lower().startswith(('license', 'copying', 'notice', 'copyright'))]
        if package['license_file']:
            candidates.append(directory / package['license_file'])
        if directory.is_relative_to(n.ROOT) and not candidates:
            candidates.append(n.ROOT / 'LICENSE')
        for path in set(candidates):
            shutil.copyfile(path, dest / path.name)
            copied.append(path.name)
        needs_source = not copied
        supplement = supplements.get(package['name'] + '@' + package['version'])
        if not copied and supplement and 'file' in supplement:
            path = supplements_dir / supplement['file']
            if n.digest(path) != supplement['sha256']:
                raise ValueError('supplemental license hash mismatch: ' + package['name'])
            shutil.copyfile(path, dest / 'UPSTREAM-NOTICE.txt')
            (dest / 'SOURCE.json').write_text(json.dumps(supplement, indent=2) + '\n')
            copied = ['UPSTREAM-NOTICE.txt', 'SOURCE.json']
        if needs_source:
            # Preserve the complete, unmodified crate when upstream did not ship a
            # standalone notice. Its copyright statements are not synthesized.
            archive = directory.parents[1].parent / 'cache' / directory.parent.name / (directory.name + '.crate')
            if not archive.is_file() or n.digest(archive) != locks.get((package['name'], package['version'])):
                raise ValueError('original crate archive/checksum unavailable: ' + package['name'])
            shutil.copyfile(archive, dest / 'original-source.crate')
            copied.append('original-source.crate')
            expression = package['license'] or ''
            for identifier in re.findall(r'[A-Za-z0-9.-]+', expression):
                canonical = supplements.get('spdx:' + identifier)
                if canonical:
                    path = supplements_dir / canonical['file']
                    if n.digest(path) != canonical['sha256']:
                        raise ValueError('SPDX license checksum mismatch')
                    filename = 'LICENSE-' + identifier + '.txt'
                    shutil.copyfile(path, dest / filename)
                    copied.append(filename)
        shutil.copyfile(package['manifest_path'], dest / 'Cargo.toml')
        inventory.append({'name': package['name'], 'version': package['version'], 'license': package['license'],
                          'source': package['source'] or 'workspace', 'notices': sorted(copied)})
    (output / 'dependencies.json').write_text(json.dumps(inventory, indent=2) + '\n')
    for path in [n.ROOT / 'LICENSE', n.ROOT / 'apps/desktop-rust/assets/fonts/NotoSans-LICENSE',
                 n.ROOT / 'crates/anynote-editor/src/board/EXCALIDRAW-LICENSE']:
        shutil.copyfile(path, output / path.name)
    return [row['name'] + '@' + row['version'] for row in inventory if not row['notices']]


def dependencies(binary, target, output):
    if target.startswith('mac-'):
        result = n.run(['otool', '-L', binary], capture_output=True, text=True).stdout
        for line in result.splitlines()[1:]:
            dep = line.strip().split(' (')[0]
            if not dep.startswith(('/System/Library/', '/usr/lib/')):
                raise ValueError('non-system Mach-O dependency: ' + dep)
    elif target.startswith('linux-'):
        result = n.run(['ldd', binary], capture_output=True, text=True).stdout
        if 'not found' in result:
            raise ValueError('unresolved Linux dynamic library')
    else:
        result = n.run(['dumpbin', '/DEPENDENTS', binary], capture_output=True, text=True).stdout
    if n.FORBIDDEN.search(result):
        raise ValueError('forbidden native dependency')
    output.write_text(result)


def tool(name, output):
    pin = n.CONFIG['linux_tools'][name]
    path = output / name
    urllib.request.urlretrieve(pin['url'], path)
    if n.digest(path) != pin['sha256']:
        raise ValueError('AppImage tool pin mismatch; review updated upstream asset before changing pin')
    path.chmod(0o755)
    return path


def build(args):
    source_identity = n.source_identity()
    notarizations = []
    target = args.target
    cfg = n.CONFIG['targets'][target]
    host = {'Darwin': 'macos', 'Linux': 'linux', 'Windows': 'windows'}[platform.system()]
    arch = {'arm64': 'aarch64', 'AMD64': 'x86_64'}.get(platform.machine(), platform.machine())
    if (host, arch) != (cfg['os'], cfg['arch']):
        raise ValueError('build on the native target runner; cross builds are not accepted')
    version = n.version()
    if args.tag and args.tag != 'v' + version:
        raise ValueError('tag does not match Cargo/package version')
    if args.sign:
        if target.startswith('linux-'):
            raise ValueError('Linux signing is not enabled; use unsigned candidates until a release signing policy is approved')
        n.credentials(target)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    payload = out / ('Anynote.app' if host == 'macos' else 'Anynote.AppDir' if host == 'linux' else 'Anynote')
    binary, resources = n.locations(payload, target)
    binary.parent.mkdir(parents=True)
    resources.mkdir(parents=True, exist_ok=True)
    command = ['cargo', 'build', '--locked', '--offline', '-p', 'anynote-desktop', '--bin', 'anynote-desktop']
    if args.profile == 'release':
        command += ['--release']
    n.run(command, cwd=n.ROOT)
    source = n.ROOT / 'target' / ('release' if args.profile == 'release' else 'debug') / binary.name
    shutil.copy2(source, binary)
    binary.chmod(0o755)
    missing_notices = notices(resources / 'licenses', cfg['triple'])
    if missing_notices:
        raise ValueError('license notices/source missing: ' + ', '.join(missing_notices))
    dependencies(binary, target, resources / 'native-dependencies.txt')
    shutil.copyfile(n.ROOT / 'docs/features/NATIVE-INSTALL.md', resources / 'INSTALL.md')
    shutil.copyfile(n.ROOT / 'apps/desktop-rust/native/release.json', resources / 'release-policy.json')
    if host == 'macos':
        info = {'CFBundleIdentifier': n.CONFIG['app_id'], 'CFBundleName': 'Anynote',
                'CFBundleDisplayName': 'Anynote', 'CFBundleExecutable': binary.name,
                'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version,
                'CFBundleVersion': version.split('-')[0], 'NSHighResolutionCapable': True,
                'LSMinimumSystemVersion': '12.0', 'NSPrincipalClass': 'NSApplication'}
        (payload / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        if args.sign:
            n.sign(payload, target)
        else:
            n.run(['codesign', '--force', '--sign', '-', payload])
        if args.sign:
            archive = out / 'notarize.zip'
            n.run(['ditto', '-c', '-k', '--keepParent', payload, archive])
            notarizations.append({'subject': 'app', **n.notarize(archive)})
            n.run(['xcrun', 'stapler', 'staple', payload])
            n.run(['xcrun', 'stapler', 'validate', payload])
            archive.unlink()
    elif host == 'windows' and args.sign:
        n.sign(binary, target)
    elif host == 'linux':
        (payload / 'AppRun').write_text('#!/bin/sh\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/usr/bin/anynote-desktop" "$@"\n')
        (payload / 'AppRun').chmod(0o755)
        (payload / 'anynote.desktop').write_text('[Desktop Entry]\nType=Application\nName=Anynote\nExec=anynote-desktop\nIcon=anynote\nCategories=Office;\nStartupWMClass=app.anynote.desktop\n')
        shutil.copyfile(n.ROOT / 'apps/browser-extension/public/icons/icon128.png', payload / 'anynote.png')
        shutil.copyfile(payload / 'anynote.png', payload / '.DirIcon')
        shutil.copyfile(n.ROOT / 'apps/browser-extension/public/icons/LICENSE-lucide', resources / 'licenses/LICENSE-app-icon')
    report = n.seal(payload, target, args.profile)
    n.verify(payload, target)
    check = n.health(payload, report)
    artifact = None
    if not args.dir:
        stem = f'Anynote-{version}-{target}'
        if host == 'macos':
            image_dir = out / 'dmg-content'
            image_dir.mkdir()
            shutil.copytree(payload, image_dir / payload.name)
            shutil.copyfile(payload.with_name(payload.name + n.MANIFEST), image_dir / (payload.name + n.MANIFEST))
            (image_dir / 'Applications').symlink_to('/Applications')
            artifact = out / (stem + '.dmg')
            n.run(['hdiutil', 'create', '-volname', 'Anynote', '-srcfolder', image_dir, '-format', 'UDZO', artifact])
            if args.sign:
                n.sign(artifact, target)
                notarizations.append({'subject': 'installer', **n.notarize(artifact)})
                n.run(['xcrun', 'stapler', 'staple', artifact])
                n.run(['xcrun', 'stapler', 'validate', artifact])
            n.run(['hdiutil', 'verify', artifact])
            shutil.rmtree(image_dir)
        elif host == 'windows':
            artifact = out / (stem + '.exe')
            compiler = shutil.which('makensis') or r'C:\Program Files (x86)\NSIS\makensis.exe'
            signing = ['/DSIGN_UNINSTALLER', '/DPYTHON=' + sys.executable, '/DSIGN_SCRIPT=' + str(n.ROOT / 'scripts/rust-release.py')] if args.sign else []
            n.run([compiler, *signing, '/DPAYLOAD=' + str(payload), '/DOUTPUT=' + str(artifact), '/DVERSION=' + version,
                   n.ROOT / 'scripts/release/windows.nsi'])
            if args.sign:
                n.sign(artifact, target)
        else:
            artifact = out / (stem + '.AppImage')
            appimagetool, runtime = tool('appimagetool', out), tool('runtime', out)
            n.run([appimagetool, '--runtime-file', runtime, payload, artifact],
                  env=dict(os.environ, APPIMAGE_EXTRACT_AND_RUN='1', ARCH='x86_64'))
            extracted = out / 'extracted'
            extracted.mkdir()
            n.run([artifact, '--appimage-extract'], cwd=extracted, stdout=subprocess.DEVNULL)
            n.verify(extracted / 'squashfs-root', target, report)
            n.health(extracted / 'squashfs-root', report)
            shutil.rmtree(extracted)
            appimagetool.unlink()
            runtime.unlink()
    source_after = n.source_identity()
    result = {'format': 'anynote.native-candidate.v1', 'version': version, 'target': target,
              'app_id': n.CONFIG['app_id'], 'source': source_identity,
              'source_unchanged': source_identity == source_after and not source_after['dirty'],
              'ci': n.ci_identity(), 'notarizations': notarizations,
              'profile': args.profile, 'signature': 'verified' if args.sign else 'unsigned-candidate',
              'acceptance': 'RM38-not-run', 'health': check, 'missing_upstream_notices': missing_notices,
              'payload_manifest_sha256': n.digest(payload.with_name(payload.name + n.MANIFEST)),
              'artifact': {'name': artifact.name, 'sha256': n.digest(artifact), 'size': artifact.stat().st_size} if artifact else None}
    (out / 'candidate.json').write_text(json.dumps(result, indent=2) + '\n')
    if artifact:
        (out / 'SHA256SUMS.txt').write_text(f'{n.digest(artifact)}  {artifact.name}\n')
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    package = commands.add_parser('build')
    host_target = {'Darwin': 'mac', 'Linux': 'linux', 'Windows': 'win'}[platform.system()] + '-' + ('arm64' if platform.machine() in ('arm64', 'aarch64') else 'x64')
    package.add_argument('--target', default=host_target, choices=n.CONFIG['targets'])
    package.add_argument('--output', type=Path)
    package.add_argument('--profile', choices=['dev', 'release'], default='release')
    package.add_argument('--dir', action='store_true')
    package.add_argument('--sign', action='store_true')
    package.add_argument('--tag')
    scan = commands.add_parser('verify')
    scan.add_argument('payload', type=Path)
    scan.add_argument('--signed', action='store_true')
    scan.add_argument('--health', action='store_true')
    signer = commands.add_parser('sign-file')
    signer.add_argument('file', type=Path)
    signer.add_argument('--target', choices=n.CONFIG['targets'], required=True)
    preflight = commands.add_parser('credentials')
    preflight.add_argument('--target', choices=n.CONFIG['targets'])
    install = commands.add_parser('install')
    install.add_argument('source', type=Path)
    install.add_argument('destination', type=Path)
    install.add_argument('--allow-unsigned-candidate', action='store_true')
    install.add_argument('--notebook', type=Path, action='append', default=[])
    args = parser.parse_args()
    if args.command == 'build':
        if args.output is None:
            args.output = n.ROOT / 'tmp/rm36' / (args.target + '-' + time.strftime('%Y%m%d-%H%M%S'))
        build(args)
    elif args.command == 'verify':
        payload = args.payload.resolve()
        report = n.verify(payload)
        if args.signed:
            n.verify_signature(payload if report['target'].startswith('mac-') else n.locations(payload, report['target'])[0], report['target'])
        if args.health:
            n.health(payload, report)
        print('Native payload verified')
    elif args.command == 'sign-file':
        n.sign(args.file, args.target)
    elif args.command == 'credentials':
        for target in [args.target] if args.target else ['mac-arm64', 'win-x64']:
            n.credentials(target)
        print('configured; real signing/notarization not run')
    else:
        print(json.dumps(n.install(args.source, args.destination, allow_unsigned=args.allow_unsigned_candidate, notebooks=args.notebook)))


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError:
        # Credential values and command arguments must not be echoed on failure.
        sys.exit('Native release tool failed; inspect the native tool output (no publication performed).')
