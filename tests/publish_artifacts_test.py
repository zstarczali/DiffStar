import importlib.util
import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('publish', Path(__file__).parents[1] / 'scripts/publish-artifacts.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def artifact(self, name):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'artifact')
        return path

    def test_collects_extracted_installers_and_guide_without_zip_wrappers(self):
        self.artifact('windows/nsis/studio.exe')
        self.artifact('mac/dmg/studio.dmg')
        self.artifact('linux/appimage/studio.AppImage')

        for name in publish.DOCUMENTS: self.artifact('guide/' + name)
        self.artifact('ignored.zip')
        self.assertEqual(set(publish.collect_files(self.root)), {'studio.exe', 'studio.dmg', 'studio.AppImage', *publish.DOCUMENTS})

    def test_rejects_missing_guide_before_connecting(self):
        self.artifact('studio.exe')
        with patch.object(publish.ftplib, 'FTP_TLS') as ftp:
            with self.assertRaisesRegex(ValueError, 'Missing installation guide'):
                publish.upload(self.root)
            ftp.assert_not_called()

    def test_rejects_duplicate_names(self):
        self.artifact('a/studio.exe')
        self.artifact('b/studio.exe')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            publish.collect_files(self.root)

    def test_uploads_to_requested_directory_with_tls_and_checks_sizes(self):
        self.artifact('studio.exe')

        for name in publish.DOCUMENTS: self.artifact(name)
        ftp = MagicMock()
        ftp.size.return_value = 8
        env = {'FTP_HOST': 'example.test', 'FTP_USERNAME': 'test', 'FTP_PASSWORD': 'test-only', 'FTP_DIRECTORY': '/www/downloads/DiffStar/'}
        with patch.dict(os.environ, env), patch.object(publish.ftplib, 'FTP_TLS') as cls:
            cls.return_value.__enter__.return_value = ftp
            publish.upload(self.root)
            self.assertTrue(cls.call_args.kwargs['context'].check_hostname)
            ftp.connect.assert_called_once_with('example.test', 21)
            ftp.prot_p.assert_called_once()
            ftp.cwd.assert_called_once_with('/www/downloads/DiffStar')
            self.assertEqual({c.args[0] for c in ftp.storbinary.call_args_list}, {'STOR studio.exe', *('STOR ' + name for name in publish.DOCUMENTS)})
            self.assertEqual(ftp.size.call_count, 4)
            ftp.delete.assert_not_called()

    def test_rejects_failed_or_unrelated_builds(self):
        response = MagicMock()
        with patch.dict(os.environ, {'BUILD_RUN_ID': '123', 'GH_REPOSITORY': 'owner/repo', 'GH_TOKEN': 'test-only'}), patch.object(publish.urllib.request, 'urlopen') as request:
            request.return_value.__enter__.return_value = response
            for run in [
                {'path': '.github/workflows/other.yml', 'status': 'completed', 'conclusion': 'success'},
                {'path': '.github/workflows/build.yml', 'status': 'completed', 'conclusion': 'failure'},
            ]:
                with patch.object(publish.json, 'load', return_value=run), self.assertRaises(ValueError):
                    publish.validate_run()

    def test_login_rejection_reports_geoip_hint_without_exposing_password(self):
        self.artifact('DiffStar.exe')
        for name in publish.DOCUMENTS:
            self.artifact(name)
        ftp = MagicMock()
        ftp.login.side_effect = publish.ftplib.error_perm('530 Login authentication failed test-password')
        env = {'FTP_HOST': 'example.test', 'FTP_USERNAME': 'test', 'FTP_PASSWORD': 'test-password', 'FTP_DIRECTORY': '/www/downloads/DiffStar/'}
        with patch.dict(os.environ, env), patch.object(publish.ftplib, 'FTP_TLS') as cls:
            cls.return_value.__enter__.return_value = ftp
            with self.assertRaises(ValueError) as caught:
                publish.upload(self.root)
        message = str(caught.exception)
        self.assertIn('530 Login authentication failed', message)
        self.assertIn('country/IP restrictions', message)
        self.assertIn('DENY', message)
        self.assertNotIn('test-password', message)
        ftp.storbinary.assert_not_called()

    def test_transfer_error_reports_the_failing_operation(self):
        self.artifact('DiffStar.exe')
        for name in publish.DOCUMENTS:
            self.artifact(name)
        ftp = MagicMock()
        ftp.storbinary.side_effect = publish.ftplib.error_perm('550 Permission denied')
        env = {'FTP_HOST': 'example.test', 'FTP_USERNAME': 'test', 'FTP_PASSWORD': 'test-only', 'FTP_DIRECTORY': '/www/downloads/DiffStar/'}
        with patch.dict(os.environ, env), patch.object(publish.ftplib, 'FTP_TLS') as cls:
            cls.return_value.__enter__.return_value = ftp
            with self.assertRaisesRegex(ValueError, 'uploading .*550 Permission denied'):
                publish.upload(self.root)

    def test_cleanup_removes_only_older_project_installers(self):
        ftp = MagicMock()
        prefix = 'DiffStar'
        current = prefix + '_1.6.0_x64-setup.exe'
        old = prefix + '_1.5.1_x64-setup.exe'
        ftp.nlst.return_value = [old, current, prefix + '_1.7.0_x64-setup.exe', 'other_1.0.0_x64-setup.exe', 'manual.pdf', '/outside/' + old, 'readme.txt']
        publish.remove_previous_installers(ftp, {current: None}, publish.PurePosixPath('/www/downloads/DiffStar'))
        ftp.delete.assert_called_once_with(old)

    def test_size_failure_prevents_cleanup(self):
        self.artifact('DiffStar_1.6.0_x64-setup.exe')
        for name in publish.DOCUMENTS:
            self.artifact(name)
        ftp = MagicMock()
        ftp.size.return_value = 0
        env = {'FTP_HOST': 'example.test', 'FTP_USERNAME': 'test', 'FTP_PASSWORD': 'test-only', 'FTP_DIRECTORY': '/www/downloads/DiffStar/'}
        with patch.dict(os.environ, env), patch.object(publish.ftplib, 'FTP_TLS') as cls:
            cls.return_value.__enter__.return_value = ftp
            with self.assertRaisesRegex(ValueError, 'size verification failed'):
                publish.upload(self.root)
        ftp.nlst.assert_not_called()
        ftp.delete.assert_not_called()

    def test_all_uploads_are_verified_before_cleanup(self):
        current = 'DiffStar_1.6.0_x64-setup.exe'
        self.artifact(current)
        for name in publish.DOCUMENTS:
            self.artifact(name)
        ftp = MagicMock()
        ftp.size.return_value = 8
        ftp.nlst.return_value = ['DiffStar_1.5.1_x64-setup.exe']
        env = {'FTP_HOST': 'example.test', 'FTP_USERNAME': 'test', 'FTP_PASSWORD': 'test-only', 'FTP_DIRECTORY': '/www/downloads/DiffStar/'}
        with patch.dict(os.environ, env), patch.object(publish.ftplib, 'FTP_TLS') as cls:
            cls.return_value.__enter__.return_value = ftp
            publish.upload(self.root)
        names = [call[0] for call in ftp.mock_calls]
        self.assertGreater(names.index('delete'), max(i for i,n in enumerate(names) if n == 'size'))
        ftp.delete.assert_called_once_with('DiffStar_1.5.1_x64-setup.exe')


if __name__ == '__main__':
    unittest.main()
