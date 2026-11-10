#!/usr/bin/env python3
"""Local mocked staging isolation proof; never connects to FTP."""
import importlib.util
import os
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
spec = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('deploy_ftp.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
ENV = dict(zip(('STAGING_FTP_' + k for k in ('HOSTNAME','PORT','USERNAME','PASSWORD','HOME_PATH')), ('staging.example.test','21','stage-user','synthetic-password','/staging')))

class StagingTests(unittest.TestCase):
    def test_explicit_settings(self):
        with patch.dict(os.environ, ENV, clear=True), patch.object(d, 'resolve_password', side_effect=AssertionError):
            self.assertEqual(d.staging_config(), ('staging.example.test',21,'stage-user','synthetic-password','/staging'))
    def test_each_missing_setting_fails_without_fallback(self):
        for key in ENV:
            env = {**ENV, 'FTP_PASSWORD':'production-placeholder'}
            del env[key]
            with self.subTest(key=key), patch.dict(os.environ, env, clear=True), self.assertRaises(SystemExit):
                d.staging_config()
    def test_unsafe_roots(self):
        for root in ('/', '', '/public_html', '/www', '/htdocs', 'staging', '/a/../b', '/a//b', '/a/', '/a\nb', '/a\\b'):
            with self.subTest(root=root), patch.dict(os.environ, {**ENV,'STAGING_FTP_HOME_PATH':root}, clear=True), self.assertRaises(SystemExit):
                d.staging_config()
    def test_production_account_and_invalid_port(self):
        for key,value in [('USERNAME',d.USER),('PORT','0'),('PORT','65536'),('PORT','x')]:
            with patch.dict(os.environ,{**ENV,'STAGING_FTP_'+key:value},clear=True), self.assertRaises(SystemExit):
                d.staging_config()
    def test_root_alias_fails_before_write(self):
        ftp=Mock(); ftp.pwd.return_value='/'
        with self.assertRaises(SystemExit): d.enter_staging_root(ftp,'/staging',{''})
        ftp.storbinary.assert_not_called(); ftp.delete.assert_not_called()
    def test_subdirectory_alias_fails(self):
        ftp=Mock(); ftp.pwd.side_effect=['/staging','/production/assets']
        with self.assertRaises(SystemExit): d.enter_staging_root(ftp,'/staging',{'','assets'})
    def test_verified_root_restored(self):
        ftp=Mock(); ftp.pwd.side_effect=['/staging','/staging/assets']
        d.enter_staging_root(ftp,'/staging',{'','assets'})
        self.assertEqual(ftp.cwd.call_args.args,('/staging',))
    def test_dry_run_has_no_mkdir_upload_delete(self):
        ftp=Mock()
        with patch.object(d,'DIST',Path(__file__).parent.parent):
            d.upload_all(ftp,{'scripts/deploy_ftp.py'},True)
        ftp.mkd.assert_not_called(); ftp.storbinary.assert_not_called()
    def test_missing_directory_fails_closed(self):
        ftp=Mock(); ftp.pwd.return_value='/staging'
        ftp.cwd.side_effect=[None,d.ftplib.error_perm('550 unavailable')]
        with self.assertRaises(SystemExit): d.enter_staging_root(ftp,'/staging',{'','assets'})
        ftp.mkd.assert_not_called()
    def test_missing_config_prevents_connection_even_allow_dirty(self):
        with patch.dict(os.environ,{},clear=True), patch('sys.argv',['deploy','--target','staging','--allow-dirty']), patch.object(d.ftplib,'FTP') as factory:
            with self.assertRaises(SystemExit): d.main()
            factory.assert_not_called()
    def test_staging_main_uses_only_staging_connection(self):
        ftp=Mock()
        with patch.dict(os.environ,ENV,clear=True), patch('sys.argv',['deploy','--target','staging']), patch.object(d,'ensure_dist_self_consistent'), patch.object(d,'ensure_dist_committed'), patch.object(d,'local_files_and_dirs',return_value=({'index.html'},{''})), patch.object(d,'resolve_password',side_effect=AssertionError), patch.object(d.ftplib,'FTP',return_value=ftp), patch.object(d,'enter_staging_root') as enter, patch.object(d,'upload_all',return_value=([],[])), patch.object(d,'prune_stale_files',return_value=([],[])):
            d.main()
            ftp.connect.assert_called_once_with('staging.example.test',21,timeout=120)
            ftp.login.assert_called_once_with('stage-user','synthetic-password')
            enter.assert_called_once_with(ftp,'/staging',{''})
    def test_remote_symlink_blocks_staging(self):
        ftp=Mock(); ftp.pwd.return_value='/staging'
        ftp.retrlines.side_effect=lambda cmd,cb: cb('lrwxrwxrwx 1 u g 1 Jan 1 00:00 index.html -> target')
        with self.assertRaises(SystemExit): d.enter_staging_root(ftp,'/staging',{''})
        ftp.storbinary.assert_not_called()
    def test_listing_failure_blocks_staging(self):
        ftp=Mock(); ftp.pwd.return_value='/staging'
        ftp.retrlines.side_effect=d.ftplib.error_perm('550 denied')
        with self.assertRaises(SystemExit): d.enter_staging_root(ftp,'/staging',{''})
    def test_malformed_listing_blocks_staging(self):
        ftp=Mock(); ftp.pwd.return_value="/staging"
        ftp.retrlines.side_effect=lambda cmd,cb: cb("unrecognized listing")
        with self.assertRaises(SystemExit): d.enter_staging_root(ftp,"/staging",{""})
        ftp.storbinary.assert_not_called()
    def test_hostile_listing_cannot_escape(self):
        ftp=Mock(); ftp.retrlines.side_effect=lambda cmd,cb: cb('-rw-r--r-- 1 u g 1 Jan 1 00:00 ../outside')
        with self.assertRaises(SystemExit): d.prune_stale_files(ftp,set(),{''},False)
        ftp.delete.assert_not_called()

if __name__ == '__main__': unittest.main()
