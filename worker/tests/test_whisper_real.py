"""Transcrição real com o modelo baixado.

Gera fala em português com a voz do próprio Windows (System.Speech, sem
internet), monta um vídeo com o FFmpeg e transcreve com o faster-whisper.
É pulado se o modelo, o FFmpeg ou a voz pt-BR não estiverem disponíveis.
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from cca_worker.audio import extract_audio
from cca_worker.config import load_settings
from cca_worker.transcribe import WhisperTranscriber, model_is_downloaded

SETTINGS = load_settings()
PHRASE = "Olá, pessoal. Bem-vindos ao canal. Primeiro, escolha um trecho com um bom gancho."


def synthesize(path: Path) -> bool:
    if os.name != "nt":
        return False
    script = (
        "Add-Type -AssemblyName System.Speech;"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1;"
        "if (-not $v) { exit 3 };"
        "$s.SelectVoice($v.VoiceInfo.Name);"
        f"$s.SetOutputToWaveFile('{path}');"
        f"$s.Speak('{PHRASE}'); $s.Dispose()"
    )
    result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, timeout=60)
    return result.returncode == 0 and path.is_file()


@unittest.skipUnless(model_is_downloaded(SETTINGS.model_path), f"modelo '{SETTINGS.model}' não baixado")
@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg não instalado")
class RealWhisperTests(unittest.TestCase):
    def test_transcribes_portuguese_with_timestamps(self):
        with tempfile.TemporaryDirectory(prefix="cca-whisper-test-") as tmp:
            tmp = Path(tmp)
            speech = tmp / "fala.wav"
            if not synthesize(speech):
                self.skipTest("voz pt-BR do Windows indisponível")
            video = tmp / "video.mp4"
            subprocess.run(
                ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:size=320x240:rate=10", "-i", str(speech),
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", str(video)],
                check=True,
            )  # fmt: skip
            audio = tmp / "audio.wav"
            extract_audio(video, audio)

            progress: list[float] = []
            result = WhisperTranscriber(SETTINGS).transcribe(audio, lambda done, total: progress.append(done / total))

            text = " ".join(s["text"] for s in result.segments).lower()
            self.assertEqual(result.language, "pt")
            for word in ("pessoal", "canal", "gancho"):
                self.assertIn(word, text)
            starts = [s["startSec"] for s in result.segments]
            self.assertEqual(starts, sorted(starts))
            words = [w for s in result.segments for w in s.get("words", [])]
            self.assertGreater(len(words), 8)
            self.assertTrue(all(0 <= w["startSec"] <= w["endSec"] <= result.duration_sec + 0.5 for w in words))
            self.assertTrue(progress and progress[-1] > 0.8)


if __name__ == "__main__":
    unittest.main()
