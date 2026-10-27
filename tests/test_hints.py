"""專有名詞放進 Whisper 提示的規則（只用 tokenizer，不需要顯示卡）。

用法：host/.venv/bin/python -m unittest tests/test_hints.py（要先執行過 install.sh，用到 large-v3-turbo 的 tokenizer）
"""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("host", Path(__file__).resolve().parents[1] / "host" / "transcriber_host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class Model:
    def __init__(self):
        import tokenizers
        from faster_whisper.utils import download_model

        self.hf_tokenizer = tokenizers.Tokenizer.from_file(str(Path(download_model("large-v3-turbo")) / "tokenizer.json"))

    def tokens(self, text):
        # faster-whisper 編碼提示時前面加一個空白
        return len(self.hf_tokenizer.encode(" " + text.strip(), add_special_tokens=False).ids)


class Hints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = Model()

    def test_no_hints_keeps_old_prompt(self):
        self.assertEqual(host.build_prompt(self.model, "en", "before", ""), f"{host.STYLE_PROMPTS['en']} before")
        self.assertIsNone(host.build_prompt(self.model, "th", "", ""))

    def test_hints_first_then_style_then_previous_text(self):
        prompt = host.build_prompt(self.model, "en", "and he wins the round.", "donk, MOUZ")
        self.assertEqual(prompt, f"donk, MOUZ {host.STYLE_PROMPTS['en']} and he wins the round.")

    def test_whitespace_collapsed(self):
        self.assertEqual(host.clip_hints(self.model, "  donk,\n  MOUZ\t"), "donk, MOUZ")
        self.assertEqual(host.clip_hints(self.model, None), "")

    def test_long_hints_clipped(self):
        hints = host.clip_hints(self.model, ", ".join(f"player{i}" for i in range(300)))
        self.assertLessEqual(self.model.tokens(hints), host.HINT_TOKENS + 1)
        self.assertTrue(hints.startswith("player0, player1"))

    def test_long_previous_text_shortened_so_hints_survive(self):
        hints = host.clip_hints(self.model, ", ".join(f"player{i}" for i in range(300)))
        for language, previous in (("en", "word " * 400), ("ja", "中山様というお殿様がおられたそうです。" * 20)):
            prompt = host.build_prompt(self.model, language, previous, hints)
            self.assertTrue(prompt.startswith("player0, player1"))
            self.assertLessEqual(self.model.tokens(prompt), host.PROMPT_TOKENS + 1)


if __name__ == "__main__":
    unittest.main()
