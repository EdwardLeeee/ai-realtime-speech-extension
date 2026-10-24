"""本機程式把一長串重複縮短、判斷狀聲詞的規則（不需要模型）。

用法：host/.venv/bin/python -m unittest tests/test_repeats.py
"""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("host", Path(__file__).resolve().parents[1] / "host" / "transcriber_host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class CollapseRepeats(unittest.TestCase):
    def check(self, text, expected):
        self.assertEqual(host.collapse_repeats(text), expected)

    def test_backchannel_with_spaces(self):
        self.check(" ".join(["うん。"] * 70), "うん。 うん。 うん。…")
        self.check("そうですか? " + " ".join(["うん。"] * 70), "そうですか? うん。 うん。 うん。…")

    def test_text_after_run_keeps_its_space(self):
        self.check("うん。 " * 6 + "そうだね。", "うん。 うん。 うん。… そうだね。")
        self.check("ha " * 8 + "happy", "ha ha ha… happy")

    def test_single_character(self):
        self.check("う" * 223, "ううう…")
        self.check("アーーーーーーー", "アーーー…")

    def test_two_character_unit_with_half_at_end(self):
        self.check("ああ。 アーオーオーオーオーオーオーオーオー", "ああ。 アーオーオーオ…")

    def test_irregular_punctuation_still_shrinks(self):
        text = "ああ ああ。 ああ。 ああ。 ああ。 ああ ああ。 ああ。 ああ。 ああ。 ああ。 " + "ーオ" * 40
        self.assertLess(len(host.collapse_repeats(text)), len(text) / 3)

    def test_english_and_thai(self):
        self.check("No, no, no, no, no, no!", "No, no, no,…!")
        self.check("ฮ่า " * 10, "ฮ่า ฮ่า ฮ่า…")

    def test_left_alone(self):
        for text in [
            "ドキドキ",
            "うん。 うん。",
            "うん。 うん。 うん。",
            "1000000",
            "It costs $1,000,000.",
            "Wait!!!!!",
            "I wonder, I wonder, I wonder how.",
            "Ooh, look, it's your girlfriend. Stop talking to me. I know.",
            "昔は、私たちの村の近くに、中山という小さなお城があって、中山様というお殿様がおられたそうです。",
            "ที่ประเทศไทยมีอากาศร้อน",
        ]:
            self.check(text, text)


class Vocalization(unittest.TestCase):
    def test_short_sounds(self):
        for text in [
            " ".join(["うん。"] * 70),
            "そうですか? " + " ".join(["うん。"] * 70),
            "う" * 223,
            "ああ ああ。 ああ。 ああ。 ああ。 ああ ああ。 ああ。 アーオーオーオーオーオーオーオーオーオー",
            "Ha ha ha ha ha ha ha ha ha ha.",
            "ฮ่า ฮ่า ฮ่า ฮ่า ฮ่า ฮ่า ฮ่า ฮ่า ฮ่า",
        ]:
            self.assertTrue(host.is_vocalization(text), text)

    def test_stuck_sentences_still_retry(self):
        # 配樂的幻覺句、泰文卡在重複（第 10 節）：單位太長，照原本的溫度重轉
        for text in [
            "ご視聴ありがとうございました " * 12,
            "チャンネル登録よろしくお願いします。" * 8,
            "ที่ประเทียม " * 15,
            "I'm driving too fast. " * 10,
            "うん。 うん。 そうですね、それでは今日の授業を始めましょう。よろしくお願いします。",
            "",
        ]:
            self.assertFalse(host.is_vocalization(text), text)


if __name__ == "__main__":
    unittest.main()
