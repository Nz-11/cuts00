import shutil
import tempfile
import unittest
import wave
from pathlib import Path

from cca_worker.audio import extract_audio
from cca_worker.transcribe import load_wav_16k_mono

from tests.test_runner import make_video


class WavTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cca-wav-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg não instalado")
    def test_extracted_audio_is_mono_16k_float(self):
        video = make_video(self.tmp / "v.mp4", with_audio=True, seconds=2)
        wav = self.tmp / "a.wav"
        extract_audio(video, wav)
        samples = load_wav_16k_mono(wav)
        self.assertEqual(str(samples.dtype), "float32")
        self.assertAlmostEqual(len(samples) / 16000, 2.0, delta=0.15)
        self.assertLessEqual(float(abs(samples).max()), 1.0)
        self.assertGreater(float(abs(samples).max()), 0.1, "o seno de teste deveria ter amplitude")

    def test_rejects_unexpected_wav_format(self):
        path = self.tmp / "estereo.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(44100)
            w.writeframes(b"\x00\x00" * 200)
        with self.assertRaises(ValueError):
            load_wav_16k_mono(path)


if __name__ == "__main__":
    unittest.main()
