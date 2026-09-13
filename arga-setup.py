"""Provision private, fictional test twins. Never print credentials or raw status."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('command', choices=['provision', 'status', 'teardown'])
parser.add_argument('--twins', choices=['gmail', 'google_drive', 'google_calendar', 'all'], default='gmail', help='Free accounts support one twin per run; all requires suitable entitlement.')
args = parser.parse_args()

def cli(*parts):
    result = subprocess.run(['arga', *parts], capture_output=True, text=True)
    if result.returncode:
        # Arga errors do not normally contain credentials; keep raw output local anyway.
        print('Arga did not complete the request. ' + ('Sign in with arga login first.' if 'authenticat' in result.stderr.lower() else 'Check account access and twin limits in Arga.'))
        sys.exit(1)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        print('Arga returned an unexpected response. No credentials were printed.'); sys.exit(1)

def save(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(data, f, indent=2)
    os.chmod(path, 0o600)

if args.command == 'provision':
    existing = ROOT / '.arga-run.json'
    if existing.exists():
        from datetime import datetime, timezone
        old = json.loads(existing.read_text())
        if old.get('status') != 'torn_down' and old.get('expires_at') and datetime.fromisoformat(old['expires_at'].replace('Z', '+00:00')) > datetime.now(timezone.utc):
            print('An unexpired environment already exists. Inspect it with npm run arga:status.'); sys.exit(0)
    prompt = ('Create fictional Reach single-switch workspace test data across Gmail, Google Drive and Google Calendar. '
              'One inbox message from Aya Okafor <aya@northstar.example> to ola@reach.example asks for a portfolio PDF and a 30-minute call. '
              'Subject: A little more about your work. Create a Drive folder named Reach Portfolios with two downloadable PDFs: '
              'Selected work 2026.pdf and Selected work 2025.pdf. Each PDF must have actual downloadable content, not only metadata. '
              'Create a primary calendar for ola@reach.example with no events. Keep all identities fictional. '
              'No emails need to be sent. Seed only these three services.')
    selected = 'gmail,google_drive,google_calendar' if args.twins == 'all' else args.twins
    if args.twins != 'all':
        prompt += ' For this run seed ONLY ' + selected + '; do not provision the other services.'
    data = cli('previews', 'twins', 'provision', '--twins', selected, '--ttl', '10', '--private', '--scenario-prompt', prompt, '--json')
    save(ROOT / '.arga-pending.json', {'run_id': data['run_id']})
    if data.get('status') == 'ready': save(ROOT / '.arga-run.json', data)
    print('Provision requested. Run npm run arga:status to fetch readiness. Run ID:', data['run_id'])
else:
    path = ROOT / '.arga-pending.json'
    if not path.exists(): path = ROOT / '.arga-run.json'
    if not path.exists(): print('No Reach twin run recorded.'); sys.exit(1)
    run_id = json.loads(path.read_text())['run_id']
    if args.command == 'teardown':
        result = subprocess.run(['arga', 'previews', 'twins', 'teardown', run_id], capture_output=True, text=True)
        if result.returncode == 0:
            manifest_path = ROOT / '.arga-run.json'
            if manifest_path.exists():
                manifest = json.loads(manifest_path.read_text())
                if manifest.get('run_id') == run_id:
                    manifest['status'] = 'torn_down'
                    save(manifest_path, manifest)
            for proof_path in (ROOT / 'artifacts').glob('arga-*-verification.json'):
                proof = json.loads(proof_path.read_text())
                if proof.get('run_id') == run_id:
                    proof['teardown_confirmed'] = True
                    proof_path.write_text(json.dumps(proof, indent=2) + '\n')
        print('Environment torn down.' if result.returncode == 0 else 'Teardown could not be confirmed.')
        sys.exit(result.returncode)
    data = cli('previews', 'twins', 'status', run_id, '--json')
    if data.get('status') == 'ready': save(ROOT / '.arga-run.json', data)
    print(json.dumps({'run_id': run_id, 'status': data.get('status'), 'expires_at': data.get('expires_at'), 'twins': list(data.get('twins', {})), 'seed_status': {k: v.get('status') if isinstance(v, dict) else 'unknown' for k, v in (data.get('seed_results') or {}).items()}}, indent=2))
