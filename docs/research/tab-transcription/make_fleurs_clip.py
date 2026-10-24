"""把幾段 FLEURS 短句接成一個連續的測試音檔（句子之間留 1.2 秒安靜），給 tests/e2e.mjs 用，並寫出對照的逐字稿。

用法：python3 docs/research/tab-transcription/make_fleurs_clip.py <FLEURS 的 tsv> <wav 資料夾> <輸出.mp3> <句子 id>...
FLEURS：https://huggingface.co/datasets/google/fleurs（CC-BY-4.0）
"""

import sys
from pathlib import Path

import av
import numpy as np
from faster_whisper import decode_audio

RATE = 16000
GAP_S = 1.2


def main():
    tsv, wav_dir, out, *ids = sys.argv[1:]
    wavs = {p.name: p for p in Path(wav_dir).rglob("*.wav")}
    rows = {}
    for line in Path(tsv).read_text(encoding="utf-8").splitlines():
        sid, name, raw, *_ = line.split("\t")
        if sid not in rows and name in wavs:
            rows[sid] = (wavs[name], raw)

    parts, lines, t = [], [], 0.0
    gap = np.zeros(int(GAP_S * RATE), dtype=np.float32)
    for sid in ids:
        path, raw = rows[sid]
        audio = decode_audio(str(path), sampling_rate=RATE)
        lines.append(f"[{t:6.1f}] {sid} {raw}")
        parts += [audio, gap]
        t += len(audio) / RATE + GAP_S
    pcm = np.concatenate(parts)
    pcm = (np.clip(pcm / max(1e-6, np.abs(pcm).max()) * 0.9, -1, 1) * 32767).astype(np.int16)

    with av.open(out, "w") as container:
        stream = container.add_stream("libmp3lame", rate=RATE)
        stream.bit_rate = 48000
        stream.layout = "mono"
        for i in range(0, len(pcm), 1152):
            frame = av.AudioFrame.from_ndarray(pcm[None, i:i + 1152], format="s16", layout="mono")
            frame.sample_rate = RATE
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    Path(out).with_suffix(".txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{out}: {t:.1f} 秒，{len(ids)} 句", file=sys.stderr)


if __name__ == "__main__":
    main()
