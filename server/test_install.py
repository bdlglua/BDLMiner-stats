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



    def test_service_is_isolated_and_only_backup_public_data(self):
        unit = installer.service('https://api.bdl-pool.com:36018')
        self.assertIn('User=bdlminer-stats', unit)
        self.assertIn('ExecStart=/opt/bdlminer-stats/app/bdlminer-stats', unit)
        self.assertNotIn('node/bin/node', unit)
        self.assertIn('ProtectHome=true', unit)
        self.assertIn('StateDirectoryMode=0700', unit)
        self.assertNotIn('ckpool', unit)
        self.assertIn('/var/backups/bdlminer-stats/public', installer.backup_service())


if __name__ == '__main__':
    unittest.main()
