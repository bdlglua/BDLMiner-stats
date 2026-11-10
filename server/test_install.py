import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('native_install', Path(__file__).with_name('install.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_domain_comes_only_from_valid_public_https_manifest(self):
        settings = dict(apiDomain='api.bdl-pool.com', apiPublicPort=36018, managedTLS=True)
        self.assertEqual(installer.public_origin(settings), 'https://api.bdl-pool.com:36018')
        for changed in (dict(apiDomain='bad\nheader'), dict(apiPublicPort=True), dict(apiPublicPort=0),
                        dict(apiDomain='https://api.example.com'), dict(managedTLS=False)):
            with self.assertRaises(installer.InstallError):
                installer.public_origin(dict(settings, **changed))

    def test_caddy_addition_preserves_pool_routes_and_is_idempotent(self):
        original = 'api.bdl-pool.com {\n    tls /cert.pem /key.pem\n    handle /api/v1/* {\n        reverse_proxy 127.0.0.1:8081\n    }\n}\n'
        result = installer.caddy_fragment(original, 'api.bdl-pool.com')
        self.assertIn('handle /api/v1/*', result)
        self.assertIn('tls /cert.pem /key.pem', result)
        self.assertEqual(result.replace(installer.HOOK, ''), original)
        self.assertEqual(installer.caddy_fragment(result, 'api.bdl-pool.com'), result)
        for source in ('other.example.com {\n}\n', 'other.example.com {\n'+installer.HOOK+'}\n',
                       original.replace('tls ', 'import /bdlminer-routes/custom\n    tls ')):
            with self.assertRaises(installer.InstallError):
                installer.caddy_fragment(source, 'api.bdl-pool.com')

    def test_caddy_routes_do_not_capture_pool_api_or_change_certificates(self):
        text = installer.caddy_routes()
        self.assertIn('/api/remote/*', text)
        self.assertIn('/api/summary', text)
        self.assertIn('reverse_proxy 127.0.0.1:8787', text)
        self.assertNotIn('/api/*', text)
        self.assertNotIn('tls ', text)

    def test_official_node_archive_is_selected_for_arm_and_x86_only(self):
        sums = '\n'.join('a'*64+'  node-v24.14.1-linux-'+arch+'.tar.xz' for arch in ('x64', 'arm64'))
        self.assertIn('linux-arm64', installer.node_archive(sums, 'aarch64')[1])
        self.assertIn('linux-x64', installer.node_archive(sums, 'x86_64')[1])
        for body, machine in ((sums, 'unknown'), ('a'*64+' node-v25.1.1-linux-x64.tar.xz', 'x86_64')):
            with self.assertRaises(installer.InstallError):
                installer.node_archive(body, machine)

    def test_archive_paths_links_and_owners_cannot_escape_runtime(self):
        for name, link in (('node-v24.test/../escape', None), ('/etc/escape', None),
                           ('node-v24.test/bin/node', '/etc/passwd'), ('node-v24.test/bin/node', '../../escape')):
            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                archive = root/'node.tar.xz'
                with tarfile.open(archive, 'w:xz') as bundle:
                    member = tarfile.TarInfo(name)
                    if link:
                        member.type = tarfile.SYMTYPE
                        member.linkname = link
                        bundle.addfile(member)
                    else:
                        member.size = 4
                        bundle.addfile(member, io.BytesIO(b'test'))
                destination = root/'runtime'
                destination.mkdir()
                with self.assertRaises(installer.InstallError):
                    installer.extract_node(archive, destination, 'node-v24.test')

    def test_service_is_isolated_and_only_backup_public_data(self):
        unit = installer.service('https://api.bdl-pool.com:36018')
        self.assertIn('User=bdlminer-stats', unit)
        self.assertIn('ProtectHome=true', unit)
        self.assertIn('StateDirectoryMode=0700', unit)
        self.assertNotIn('ckpool', unit)
        self.assertIn('/var/backups/bdlminer-stats/public', installer.backup_service())


if __name__ == '__main__':
    unittest.main()
