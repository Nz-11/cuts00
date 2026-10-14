import tempfile
import unittest
from pathlib import Path

from cca_worker.api import ApiDisabled, AppUnreachable, JobGone, Unauthorized, WorkerApi
from cca_worker.config import load_settings, parse_env_file

from tests.fake_app import FakeApp


class ConfigTests(unittest.TestCase):
    def test_parse_env_file(self):
        text = '# comentário\nA=1\nB="com espaço # não é comentário"\nC=valor # comentário\nexport D=4\nINVALIDA\n=sem_chave\n'
        self.assertEqual(parse_env_file(text), {"A": "1", "B": "com espaço # não é comentário", "C": "valor", "D": "4"})

    def test_env_local_and_precedence(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp)
            (app / ".env").write_text("CCA_WHISPER_MODEL=base\nCCA_WORKER_TOKEN=do-env\n", encoding="utf-8")
            (app / ".env.local").write_text("CCA_WORKER_TOKEN=do-env-local\nCCA_DATA_DIR=dados\n", encoding="utf-8")
            s = load_settings(app, environ={"CCA_WHISPER_LANGUAGE": "auto"})
            self.assertEqual(s.token, "do-env-local")
            self.assertEqual(s.model, "base")
            self.assertIsNone(s.language)
            self.assertEqual(s.data_dir, (app / "dados").resolve())
            self.assertEqual(load_settings(app, environ={"CCA_WORKER_TOKEN": "do-processo"}).token, "do-processo")

    def test_defaults_are_cpu_int8_portuguese(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = load_settings(Path(tmp), environ={})
            self.assertEqual((s.model, s.language, s.device, s.compute_type), ("small", "pt", "cpu", "int8"))
            self.assertEqual(s.data_dir, (Path(tmp) / ".data").resolve())
            self.assertFalse(s.token_defined)

    def test_token_not_in_repr(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = load_settings(Path(tmp), environ={"CCA_WORKER_TOKEN": "segredo-super-secreto"})
            self.assertNotIn("segredo-super-secreto", repr(s))

    def test_invalid_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            for env in ({"CCA_WHISPER_MODEL": "gigante"}, {"CCA_WHISPER_THREADS": "zero"}, {"CCA_APP_URL": "ftp://x"}, {"CCA_WHISPER_LANGUAGE": "../x"}):
                with self.assertRaises(ValueError, msg=env):
                    load_settings(Path(tmp), environ=env)


class ApiTests(unittest.TestCase):
    def test_sends_bearer_and_lists_jobs(self):
        with FakeApp() as app:
            self.assertEqual(WorkerApi(app.url, app.token).list_jobs(), [])
            self.assertEqual(app.calls[0][3], f"Bearer {app.token}")

    def test_error_mapping_without_leaking_token(self):
        with FakeApp() as app:
            with self.assertRaises(Unauthorized) as ctx:
                WorkerApi(app.url, "token-errado-secreto").list_jobs()
            self.assertNotIn("token-errado-secreto", str(ctx.exception))
            with self.assertRaises(JobGone):
                WorkerApi(app.url, app.token).progress("p_inexistente", 0.5, "x")
        with FakeApp(status=503) as app:
            with self.assertRaises(ApiDisabled):
                WorkerApi(app.url, app.token).list_jobs()

    def test_unreachable(self):
        with self.assertRaises(AppUnreachable):
            WorkerApi("http://127.0.0.1:9", "t", timeout=2).list_jobs()


if __name__ == "__main__":
    unittest.main()
