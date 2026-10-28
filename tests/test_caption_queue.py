"""YouTube 字幕模式的翻譯排隊（不啟動翻譯模型，也不需要顯示卡）。

用法：host/.venv/bin/python -m unittest tests/test_caption_queue.py
"""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("host", Path(__file__).resolve().parents[1] / "host" / "transcriber_host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class Idle(host.Translator):
    def _run(self):  # 不開翻譯執行緒，只看排隊的內容
        pass


def texts(*items):
    return [{"start": start, "end": start + 2, "text": text} for start, text in items]


class CaptionQueue(unittest.TestCase):
    def setUp(self):
        self.t = Idle({}, "en", partials=False)
        self.t.enabled = True

    def test_each_segment_is_one_unit_with_tag(self):
        # 插件已經照句子湊好：沒有句號的也不等，直接排進去
        self.t.add_texts(texts((1.0, "Hello there"), (3.0, "how are you?")), "vid#1", replace=False)
        self.assertEqual(list(self.t.finals), [("unit", 1.0, "vid#1", "Hello there"), ("unit", 3.0, "vid#1", "how are you?")])
        self.assertEqual(self.t.held, [])

    def test_replace_drops_queued_units_but_keeps_flush(self):
        self.t.add_texts(texts((1.0, "one."), (3.0, "two.")), "vid#1", replace=False)
        self.t.finals.append(("flush",))
        self.t.add_texts(texts((40.0, "forty.")), "vid#1", replace=True)
        self.assertEqual(list(self.t.finals), [("flush",), ("unit", 40.0, "vid#1", "forty.")])

    def test_append_keeps_order(self):
        self.t.add_texts(texts((1.0, "one.")), "a", replace=False)
        self.t.add_texts(texts((3.0, "two.")), "a", replace=False)
        self.assertEqual([job[1] for job in self.t.finals], [1.0, 3.0])

    def test_ignored_when_translation_is_off(self):
        self.t.enabled = False
        self.t.add_texts(texts((1.0, "one.")), "a", replace=False)
        self.assertEqual(list(self.t.finals), [])

    def test_whisper_units_have_no_tag(self):
        self.t.add_segments(texts((1.0, "A full sentence.")))
        self.assertEqual(list(self.t.finals), [("unit", 1.0, None, "A full sentence.")])


if __name__ == "__main__":
    unittest.main()
