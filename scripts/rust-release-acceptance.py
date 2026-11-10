#!/usr/bin/env python3
"""Prepare/check an RM38 evidence bundle. Does not sign, install, publish or open user data."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
from release import acceptance as a


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['init', 'check'])
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--output', type=Path, required=True, help='New output file; never overwrite evidence')
    args = parser.parse_args()
    if args.command == 'init':
        result = a.template()
    else:
        bundle = a.read_json(args.evidence) if args.evidence else a.template()
        base = args.evidence.resolve().parent if args.evidence else a.n.ROOT
        result = a.evaluate(bundle, base)
        result['checked_at'] = datetime.now(timezone.utc).isoformat()
        if args.evidence:
            result['evidence_sha256'] = a.n.digest(args.evidence)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'status': result.get('status', 'template-not-acceptance'),
                      'records': len(result['records']), 'publication_authorized': False}))
    return 2 if result.get('status') == 'blocked' else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        sys.exit(f'Invalid RM38 evidence: {error}')
