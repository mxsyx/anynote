"""Download and verify the repository-pinned no-V8 Pdfium artifact, retaining notices."""
import argparse
import hashlib
import json
import platform
import tarfile
import tempfile
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--archive', type=Path, help='Use an existing archive after validating the same pin')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--platform', choices=['linux-x64', 'mac-arm64', 'mac-x64', 'win-arm64', 'win-x64'])
args = parser.parse_args()
target = args.platform or {'Darwin': 'mac', 'Linux': 'linux', 'Windows': 'win'}[platform.system()] + '-' + {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'AMD64': 'x64'}[platform.machine()]
pin = json.loads((root / 'apps/desktop-rust/native/pdfium.json').read_text())
asset = next(a for a in pin['assets'] if a['name'] == f'pdfium-{target}.tgz')
if args.output.exists():
    raise SystemExit('Output already exists; choose a new directory')
with tempfile.TemporaryDirectory() as temporary:
    archive = Path(temporary) / asset['name']
    if args.archive:
        import shutil
        shutil.copyfile(args.archive, archive)
    else:
        urllib.request.urlretrieve(asset['url'], archive)
    if archive.stat().st_size != asset['size'] or hashlib.sha256(archive.read_bytes()).hexdigest() != asset['sha256']:
        raise SystemExit('Pdfium archive does not match the repository pin')
    with tarfile.open(archive) as source:
        source.extractall(args.output, filter='data')
    (args.output / 'anynote-artifact.json').write_text(json.dumps(asset, indent=2) + '\n')
print(args.output.resolve())
