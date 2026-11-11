#!/usr/bin/env python3
"""Install the native collector alongside the existing pool API, as root."""
import fcntl
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import socket
import ssl
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path('/opt/bdlminer-stats')
DATA = Path('/var/lib/bdlminer-stats')
PUBLIC = Path('/etc/bdl-pool-openport/public.json')
FRAGMENT = Path('/etc/caddy/conf.d/bdl-pool-api.caddy')
ROUTES = Path('/etc/caddy/bdlminer-routes/stats.caddy')
UNIT = Path('/etc/systemd/system/bdlminer-stats.service')
BACKUP_UNIT = UNIT.with_name('bdlminer-stats-backup.service')
BACKUP_TIMER = UNIT.with_name('bdlminer-stats-backup.timer')
HOOK = '    import /etc/caddy/bdlminer-routes/*.caddy\n'
LEGACY = 'https://bdlminer-stats.bdlminer-bot.workers.dev/api/summary'
USER = 'bdlminer-stats'


class InstallError(Exception):
    pass


def run(args, message=None):
    if message:
        print(message, flush=True)
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True, timeout=180)
    if result.returncode:
        if ROOT.is_dir():
            log = ROOT/'install-error.log'
            write(log, result.stdout+'\n'+result.stderr, 0o600)
            detail = ' Journal local : '+str(log)
        else:
            detail = ' Consulter les journaux locaux du service.'
        raise InstallError('Échec : '+(message or str(args[0]))+'.'+detail)
    return result.stdout


def download(url, limit):
    request = Request(url, headers={'User-Agent': 'BDLMiner-selfhost-installer/1.0'})
    with urlopen(request, timeout=45) as response:
        body = response.read(limit+1)
    if len(body) > limit:
        raise InstallError('Téléchargement trop volumineux.')
    return body


def write(path, content, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    path.parent.chmod(0o755)
    temporary = path.with_name(path.name+'.installing')
    with temporary.open('wb') as output:
        output.write(content.encode() if isinstance(content, str) else content)
        output.flush()
        os.fsync(output.fileno())
    temporary.chmod(mode)
    os.replace(temporary, path)


def public_origin(settings):
    host, port = settings.get('apiDomain'), settings.get('apiPublicPort')
    if (not isinstance(host, str) or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?', host)
            or '.' not in host or type(port) is not int or not 1024 <= port <= 65535
            or settings.get('managedTLS') is not True):
        raise InstallError('Configuration HTTPS du relais invalide. Installer d’abord le domaine de l’API du pool.')
    return 'https://'+host+':'+str(port)


def caddy_fragment(text, host):
    if not text.startswith(host+' {\n'):
        raise InstallError('Le fragment Caddy ne correspond pas au domaine de l’API.')
    if text.count(HOOK) == 1:
        return text
    if 'bdlminer-routes' in text:
        raise InstallError('Le fragment Caddy a été personnalisé. Aucun remplacement automatique.')
    return text.replace(host+' {\n', host+' {\n'+HOOK, 1)


def caddy_routes():
    # This is imported INSIDE the existing API host, not as a second site.
    return '''# Managed by BDLMiner-stats/server/install.py
@bdlminer_stats path /report /api/summary /api/remote /api/remote/* /healthz /remote /remote/ /remote.js /remote.css
handle @bdlminer_stats {
    reverse_proxy 127.0.0.1:8787 {
        header_up -CF-Connecting-IP
        header_up -X-Real-IP
        transport http {
            dial_timeout 3s
            response_header_timeout 15s
        }
    }
}
'''








def service(origin):
    return '''[Unit]
Description=BDLMiner Rust statistics collector
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=bdlminer-stats
Group=bdlminer-stats
WorkingDirectory=/opt/bdlminer-stats/app
ExecStart=/opt/bdlminer-stats/app/bdlminer-stats
Environment=STATS_DATA=/var/lib/bdlminer-stats
Environment=STATS_PUBLIC_ORIGIN='''+origin+'''
EnvironmentFile=-/etc/bdlminer-stats.conf
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
StateDirectory=bdlminer-stats
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=256M
TasksMax=64
LimitNOFILE=512

[Install]
WantedBy=multi-user.target
'''


def backup_service():
    return '''[Unit]
Description=BDLMiner public statistics SQLite backup
After=bdlminer-stats.service

[Service]
Type=oneshot
User=bdlminer-stats
Group=bdlminer-stats
ExecStart=/opt/bdlminer-stats/app/bdlminer-stats backup
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/backups/bdlminer-stats/public
MemoryMax=128M
TasksMax=32
'''


def active(unit):
    return subprocess.run(['systemctl', 'is-active', '--quiet', unit], capture_output=True).returncode == 0


def local_json(path, host=None):
    if host:
        connection = http.client.HTTPSConnection(host, 443, timeout=5)
        raw = socket.create_connection(('127.0.0.1', 443), timeout=5)
        connection.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
    else:
        connection = http.client.HTTPConnection('127.0.0.1', 8787, timeout=3)
    try:
        connection.request('GET', path)
        response = connection.getresponse()
        if response.status != 200:
            raise InstallError('Le contrôle HTTP local a échoué.')
        return json.loads(response.read(1024*1024))
    finally:
        connection.close()


def wait_native():
    deadline = time.monotonic()+30
    while time.monotonic() < deadline:
        try:
            if local_json('/healthz').get('runtime') == 'rust':
                return
        except (OSError, ValueError, InstallError, http.client.HTTPException):
            pass
        time.sleep(.5)
    raise InstallError('Le collecteur ne répond pas. Vérifier : sudo journalctl -u bdlminer-stats -n 25 --no-pager')


def install():
    if os.geteuid() != 0:
        raise InstallError('Lancer avec sudo python3 '+str(Path(__file__).resolve()))
    for command in ('systemctl', 'caddy', 'runuser', 'ss', 'useradd'):
        if not shutil.which(command):
            raise InstallError('Outil absent : '+command+'. Installer d’abord l’API du pool.')
    settings = json.loads(PUBLIC.read_text())
    origin = public_origin(settings)
    host = settings['apiDomain']
    previous_fragment = FRAGMENT.read_bytes()
    fragment = caddy_fragment(previous_fragment.decode(), host)
    if ROUTES.exists() and ROUTES.read_text() != caddy_routes():
        raise InstallError('Les routes BDLMiner ont été personnalisées. Configuration conservée.')
    if not active('caddy.service'):
        raise InstallError('Caddy doit déjà être actif pour l’API du pool.')
    before = local_json('/api/v1/health', host)
    if before.get('status') != 'ok':
        raise InstallError('L’API du pool ne répond pas normalement. Aucune modification.')
    listeners = run(['ss', '-H', '-ltn', 'sport = :8787'])
    was_active = active('bdlminer-stats.service')
    if listeners.strip() and not was_active:
        raise InstallError('Le port local 8787 est occupé. Aucun service arrêté.')
    ROOT.mkdir(parents=True, exist_ok=True)
    ROOT.chmod(0o755)

    try:
        account = pwd.getpwnam(USER)
    except KeyError:
        run(['useradd', '--system', '--user-group', '--home-dir', str(DATA), '--no-create-home', '--shell', '/usr/sbin/nologin', USER])
        account = pwd.getpwnam(USER)
    DATA.mkdir(mode=0o700, exist_ok=True)
    DATA.chmod(0o700)
    os.chown(DATA, account.pw_uid, account.pw_gid)
    if not (DATA/'public.sqlite').exists() and not (DATA/'legacy-summary.json').exists():
        try:
            snapshot = download(LEGACY, 1024*1024)
            value = json.loads(snapshot)
            if (not isinstance(value, dict) or type(value.get('at')) is not int or
                    not isinstance(value.get('recent'), list) or not isinstance(value.get('history'), list)):
                raise InstallError('Format de l’historique public invalide.')
            snapshot_path = DATA/'legacy-summary.json'
            # DATA must retain mode 0700; write() intentionally creates public config directories.
            snapshot_path.write_bytes(snapshot)
            snapshot_path.chmod(0o600)
            os.chown(snapshot_path, account.pw_uid, account.pw_gid)
            print('Historique public récupéré : relevés 24 h, courbe horaire 7 jours et record.', flush=True)
        except (OSError, ValueError, InstallError, HTTPError):
            print('Cloudflare ne fournit pas l’historique actuellement ; le collecteur démarrera sans import.', flush=True)
    releases = ROOT/'releases'
    releases.mkdir(exist_ok=True)
    releases.chmod(0o755)
    release = releases/str(time.time_ns())
    release.mkdir(mode=0o755)
    source = Path(__file__).resolve().parent.parent
    binary = source/'rust/target/release/bdlminer-stats'
    if binary.is_symlink() or not binary.is_file():
        raise InstallError('Compiler d’abord : cargo build --locked --release --manifest-path rust/Cargo.toml')
    write(release/'bdlminer-stats', binary.read_bytes(), 0o755)
    if (source/'LICENSE').is_file():
        write(release/'LICENSE', (source/'LICENSE').read_bytes())
    backup_directory = Path('/var/backups/bdlminer-stats/public')
    backup_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup_directory.parent.chmod(0o755)
    backup_directory.chmod(0o700)
    os.chown(backup_directory, account.pw_uid, account.pw_gid)
    managed = (FRAGMENT, ROUTES, UNIT, BACKUP_UNIT, BACKUP_TIMER)
    originals = {path: path.read_bytes() if path.exists() else None for path in managed}
    app = ROOT/'app'
    if app.exists() and not app.is_symlink():
        raise InstallError('Le dossier /opt/bdlminer-stats/app existe sans lien géré. Aucun remplacement.')
    previous_app = os.readlink(app) if app.is_symlink() else None
    rollback = ROOT/('before-'+str(time.time_ns()))
    rollback.mkdir(mode=0o700)
    for index, (path, content) in enumerate(originals.items()):
        if content is not None:
            write(rollback/(str(index)+'-'+path.name), content, 0o600)
    rollback.chmod(0o700)
    try:
        next_app = ROOT/'app.installing'
        next_app.unlink(missing_ok=True)
        next_app.symlink_to(release)
        os.replace(next_app, app)
        write(UNIT, service(origin))
        write(BACKUP_UNIT, backup_service())
        write(BACKUP_TIMER, '''[Unit]
Description=Daily BDLMiner public statistics backup
[Timer]
OnCalendar=daily
RandomizedDelaySec=10m
Persistent=true
[Install]
WantedBy=timers.target
''')
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'restart', 'bdlminer-stats.service'], 'Démarrage du collecteur local')
        wait_native()
        write(ROUTES, caddy_routes())
        write(FRAGMENT, fragment)
        run(['runuser', '-u', 'caddy', '--', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile'], 'Validation de Caddy')
        run(['systemctl', 'reload', 'caddy.service'], 'Activation des routes HTTPS des statistiques')
        if local_json('/healthz', host).get('runtime') != 'rust' or local_json('/api/v1/health', host).get('status') != 'ok':
            raise InstallError('Contrôle HTTPS local non confirmé.')
        run(['systemctl', 'enable', 'bdlminer-stats.service'])
        run(['systemctl', 'start', 'bdlminer-stats-backup.service'])
        run(['systemctl', 'enable', '--now', 'bdlminer-stats-backup.timer'])
    except Exception:
        print('Restauration de la configuration précédente.', flush=True)
        for unit in (UNIT, BACKUP_TIMER):
            if originals[unit] is None:
                subprocess.run(['systemctl', 'disable', '--now', unit.name], capture_output=True)
        for path, content in originals.items():
            if content is None:
                path.unlink(missing_ok=True)
            else:
                write(path, content)
        app.unlink(missing_ok=True)
        if previous_app:
            app.symlink_to(previous_app)
        subprocess.run(['systemctl', 'daemon-reload'], capture_output=True)
        subprocess.run(['systemctl', 'reload', 'caddy.service'], capture_output=True)
        subprocess.run(['systemctl', 'restart' if was_active else 'stop', 'bdlminer-stats.service'], capture_output=True)
        raise
    print('Statistiques hébergées sur le serveur. SQLite et sauvegarde publique quotidienne actifs.')
    print('Test public : '+origin+'/healthz')
    print('Résumé public : '+origin+'/api/summary')
    print('Le site et les firmwares n’ont pas encore changé d’adresse de collecte.')
    print('Bitcoin Core, CKPool et les relais OpenPort n’ont pas été redémarrés.')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        with open('/run/lock/bdlminer-stats-install.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            install()
    except BlockingIOError:
        sys.exit('Une installation BDLMiner est déjà en cours.')
    except (InstallError, OSError, ValueError, subprocess.SubprocessError):
        error = sys.exc_info()[1]
        sys.exit(str(error) if isinstance(error, InstallError) else 'Installation interrompue. Configuration et données conservées ; consulter les journaux locaux.')
