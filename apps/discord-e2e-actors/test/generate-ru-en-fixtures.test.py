"""Offline generator contract: python3 <this-file>; no macOS/audio/provider needed."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[1]
BASE = "966dffc8fcd2ccd63f9fba357e03ba0a8eef7a7c"
SCRIPT = "apps/discord-e2e-actors/scripts/generate-ru-en-fixtures.sh"
FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
def value(flag):
    return args[args.index(flag) + 1]
if name == 'say':
    text = pathlib.Path(value('-f')).read_text() if '-f' in args else args[-1]
    record = [name, value('-v'), value('-r'), text]
    pathlib.Path(value('-o')).write_text(json.dumps(record, ensure_ascii=False))
elif name == 'ffmpeg':
    source = pathlib.Path(value('-i'))
    if '-f' in args and value('-f') == 'concat':
        data = b''.join(pathlib.Path(line[6:-1]).read_bytes()
                        for line in source.read_text().splitlines())
    else:
        data = source.read_bytes()
    normalized = [pathlib.Path(a).name if a == str(source) or a == args[-1]
                  else a for a in args]
    record = [name, *normalized]
    pathlib.Path(args[-1]).write_bytes(data + json.dumps(record).encode())
else:
    print('opus' if value('-show_entries') == 'stream=codec_name' else '12.345')
    sys.exit(0)
with open(os.environ['GENERATOR_TEST_LOG'], 'a') as log:
    log.write(json.dumps(record, ensure_ascii=False) + '\n')
'''


class GeneratorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fixture generator ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("say", "ffmpeg", "ffprobe"):
            path = self.bin / name
            path.write_text(FAKE)
            path.chmod(0o755)
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith("DISCORD_E2E_")}
        self.env["PATH"] = str(self.bin) + os.pathsep + self.env["PATH"]

    def run_generator(self, label, overrides=None, baseline=False, fresh=True, shell=("sh",)):
        package = self.root / label
        (package / "scripts").mkdir(parents=True)
        fixtures = package / "test/fixtures"
        fixtures.mkdir(parents=True)
        for speaker in ("speaker-a", "speaker-b"):
            shutil.copyfile(PACKAGE / "test/fixtures" / f"{speaker}.ru-en.txt",
                            fixtures / f"{speaker}.ru-en.txt")
            (fixtures / f"{speaker}.ru-en.ogg").write_bytes(b"retained sentinel")
        script = package / "scripts/generate-ru-en-fixtures.sh"
        script.write_bytes(subprocess.check_output(
            ["git", "show", f"{BASE}:{SCRIPT}"], cwd=PACKAGE) if baseline
            else (PACKAGE / "scripts/generate-ru-en-fixtures.sh").read_bytes())
        output = package / "fresh candidate"
        log = package / "calls.jsonl"
        env = dict(self.env, GENERATOR_TEST_LOG=str(log))
        if fresh:
            env["DISCORD_E2E_FIXTURE_OUTPUT_DIR"] = str(output)
        env.update(overrides or {})
        result = subprocess.run([*shell, str(script)], env=env, capture_output=True,
                                text=True, timeout=30)
        calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return result, calls, output if fresh else fixtures, fixtures, env, script

    def test_defaults_match_exact_base_and_fresh_destination(self):
        old = self.run_generator("base", baseline=True, fresh=False)
        default = self.run_generator("default", fresh=False)
        fresh = self.run_generator("fresh")
        for run in (old, default, fresh):
            self.assertEqual(run[0].returncode, 0, run[0].stderr)
            self.assertEqual(run[1], old[1])
            self.assertEqual(run[0].stdout, old[0].stdout)
            for speaker in ("speaker-a", "speaker-b"):
                name = f"{speaker}.ru-en.ogg"
                self.assertEqual((run[2] / name).read_bytes(), (old[2] / name).read_bytes())
        self.assertFalse((default[2] / "generation.v1.tsv").exists())
        for path in fresh[3].glob("*.ogg"):
            self.assertEqual(path.read_bytes(), b"retained sentinel")

    def test_only_two_exact_segments_change_with_deterministic_provenance(self):
        normal = self.run_generator("normal")
        changed = self.run_generator("changed", {"DISCORD_E2E_TTS_PIPECAT_RATE": "140"})
        repeat = self.run_generator("repeat", {"DISCORD_E2E_TTS_PIPECAT_RATE": "140"})
        for run in (normal, changed, repeat):
            self.assertEqual(run[0].returncode, 0, run[0].stderr)
        differences = []
        self.assertEqual(len(normal[1]), len(changed[1]))
        for before, after in zip(normal[1], changed[1]):
            if before != after:
                self.assertEqual(before, ["say", "Daniel", "150", "Pipecat assistant."])
                self.assertEqual(after, ["say", "Daniel", "140", "Pipecat assistant."])
                differences.append(after)
        self.assertEqual(len(differences), 2)
        provenance = (changed[2] / "generation.v1.tsv").read_bytes()
        self.assertEqual(provenance, (repeat[2] / "generation.v1.tsv").read_bytes())
        rows = [line.split('\t') for line in provenance.decode().splitlines()]
        segments = [row for row in rows if row[0] == "segment"]
        calls = [call for call in changed[1] if call[0] == "say"]
        self.assertEqual(len(segments), len(calls))
        for row, call in zip(segments, calls):
            self.assertEqual(row[3:5], call[1:3])
            self.assertEqual(row[5], "@source" if row[1] == "speaker-a" else call[3])
        b_segments = [row for row in segments if row[1] == "speaker-b"]
        self.assertEqual([int(row[2]) for row in b_segments], list(range(1, len(b_segments) + 1)))
        for row in rows:
            if row[0] in ("audio", "source"):
                suffix = "ogg" if row[0] == "audio" else "txt"
                directory = changed[2] if suffix == "ogg" else changed[3]
                digest = hashlib.sha256((directory / f"{row[1]}.ru-en.{suffix}").read_bytes()).hexdigest()
                self.assertEqual(row[-1], digest)
        for path in changed[3].glob("*.ogg"):
            self.assertEqual(path.read_bytes(), b"retained sentinel")

    def test_unset_phrase_rate_inherits_english_settings(self):
        settings = {"DISCORD_E2E_TTS_ENGLISH_RATE": "175",
                    "DISCORD_E2E_TTS_ENGLISH_VOICE": "Test English",
                    "DISCORD_E2E_TTS_RATE": "135", "DISCORD_E2E_TTS_VOICE": "Test Russian"}
        old = self.run_generator("custom-base", settings, baseline=True, fresh=False)
        new = self.run_generator("custom-new", settings)
        self.assertEqual(old[0].returncode, 0, old[0].stderr)
        self.assertEqual(new[0].returncode, 0, new[0].stderr)
        self.assertEqual(old[1], new[1])
        self.assertEqual(old[0].stdout, new[0].stdout)

    def test_reject_oversized_pipecat_rate_before_destination_or_synthesis(self):
        for shell in (("sh",), ("bash", "--posix")):
            with self.subTest(shell=shell):
                run = self.run_generator(
                    f"oversized-{shell[0]}",
                    {"DISCORD_E2E_TTS_PIPECAT_RATE": "999999999999999999999999999999"},
                    shell=shell)
                self.assertEqual(run[0].returncode, 1, run[0].stderr)
                self.assertEqual(
                    run[0].stderr,
                    "DISCORD_E2E_TTS_PIPECAT_RATE must be an integer from 100 to 250\n")
                self.assertEqual(run[1], [])
                self.assertFalse(run[2].exists())

    def test_pipecat_rate_range_boundaries(self):
        for shell in (("sh",), ("bash", "--posix")):
            for rate in ("100", "199", "200", "249", "250"):
                with self.subTest(shell=shell, rate=rate):
                    run = self.run_generator(
                        f"valid-{shell[0]}-{rate}",
                        {"DISCORD_E2E_TTS_PIPECAT_RATE": rate}, shell=shell)
                    self.assertEqual(run[0].returncode, 0, run[0].stderr)
                    phrases = [call for call in run[1]
                               if call[0] == "say" and call[3] == "Pipecat assistant."]
                    self.assertEqual(phrases, [["say", "Daniel", rate, "Pipecat assistant."]] * 2)

    def test_reject_invalid_rates_and_existing_destination_before_synthesis(self):
        for i, rate in enumerate(("", "99", "251", "abc", "140.5")):
            run = self.run_generator(f"invalid{i}", {"DISCORD_E2E_TTS_PIPECAT_RATE": rate})
            self.assertNotEqual(run[0].returncode, 0)
            self.assertEqual(run[1], [])
            self.assertFalse(run[2].exists())
        run = self.run_generator("no-output", {"DISCORD_E2E_TTS_PIPECAT_RATE": "140"}, fresh=False)
        self.assertNotEqual(run[0].returncode, 0)
        self.assertEqual(run[1], [])
        run = self.run_generator("existing")
        before = {p.name: p.read_bytes() for p in run[2].iterdir()}
        log_before = Path(run[4]["GENERATOR_TEST_LOG"]).read_bytes()
        result = subprocess.run(["sh", str(run[5])], env=run[4], capture_output=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, {p.name: p.read_bytes() for p in run[2].iterdir()})
        self.assertEqual(log_before, Path(run[4]["GENERATOR_TEST_LOG"]).read_bytes())


if __name__ == "__main__":
    unittest.main()
