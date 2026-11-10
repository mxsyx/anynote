"""Ephemeral CI certificate import. Secrets remain in environment/private temp files."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
from native import ROOT, run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'cleanup'])
    parser.add_argument('--target', choices=['mac', 'win'], required=True)
    args = parser.parse_args()
    directory = Path(os.environ['RUNNER_TEMP']) / 'anynote-signing'
    if args.command == 'cleanup':
        if args.target == 'mac' and (directory / 'identity.keychain-db').exists():
            run(['security', 'delete-keychain', directory / 'identity.keychain-db'], capture_output=True)
        if args.target == 'win' and (directory / 'imported.json').exists():
            env = dict(os.environ, ANYNOTE_IMPORTED_SIGNER=json.loads((directory / 'imported.json').read_text())['thumbprint'])
            run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
                 r'Remove-Item -LiteralPath ("Cert:\CurrentUser\My\"+$env:ANYNOTE_IMPORTED_SIGNER)'], env=env, capture_output=True)
        import shutil
        shutil.rmtree(directory, ignore_errors=True)
        return
    directory.mkdir(mode=0o700, exist_ok=False)
    prefix = 'MAC' if args.target == 'mac' else 'WIN'
    encoded = os.environ['ANYNOTE_' + prefix + '_CERTIFICATE_B64']
    certificate = directory / 'identity.p12'
    certificate.write_bytes(base64.b64decode(encoded, validate=True))
    certificate.chmod(0o600)
    password = os.environ['ANYNOTE_' + prefix + '_CERTIFICATE_PASSWORD']
    if args.target == 'mac':
        keychain = directory / 'identity.keychain-db'
        key_password = secrets.token_urlsafe(32)
        run(['security', 'create-keychain', '-p', key_password, keychain], capture_output=True)
        run(['security', 'set-keychain-settings', '-lut', '21600', keychain], capture_output=True)
        run(['security', 'unlock-keychain', '-p', key_password, keychain], capture_output=True)
        run(['security', 'import', certificate, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign'], capture_output=True)
        run(['security', 'set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', key_password, keychain], capture_output=True)
        profile = 'anynote.native.release'
        run(['xcrun', 'notarytool', 'store-credentials', profile, '--keychain', keychain,
             '--apple-id', os.environ['APPLE_ID'], '--team-id', os.environ['ANYNOTE_MAC_TEAM_ID'],
             '--password', os.environ['APPLE_APP_SPECIFIC_PASSWORD']], capture_output=True)
        with Path(os.environ['GITHUB_ENV']).open('a') as stream:
            stream.write(f'ANYNOTE_MAC_KEYCHAIN={keychain}\nANYNOTE_NOTARY_PROFILE={profile}\n')
    else:
        env = dict(os.environ, ANYNOTE_IMPORT_CERTIFICATE=str(certificate))
        result = run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
                      '$p=ConvertTo-SecureString $env:ANYNOTE_WIN_CERTIFICATE_PASSWORD -AsPlainText -Force; '
                      r'$c=Import-PfxCertificate -FilePath $env:ANYNOTE_IMPORT_CERTIFICATE -CertStoreLocation Cert:\CurrentUser\My -Password $p; '
                      '$c.Thumbprint'], env=env, capture_output=True, text=True)
        thumbprint = result.stdout.strip()
        (directory / 'imported.json').write_text(json.dumps({'thumbprint': thumbprint}))
        if thumbprint.upper() != os.environ['ANYNOTE_WIN_CERT_SHA1'].upper():
            raise ValueError('imported certificate does not match expected publisher')
        (directory / 'imported.json').write_text(json.dumps({'thumbprint': thumbprint}))
    certificate.unlink()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Subprocess repr includes passwords. Never print it or secret values.
        raise SystemExit('Signing identity setup/cleanup failed; verify configured secrets and native identity permissions.') from None
