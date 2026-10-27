"""背景一直有聲音時，錄音頁的切段規則（照 extension/offscreen.js）會切出多長的段落、切點是不是在停頓、講話有沒有都送出。只用 CPU。

講話：alice 60–180 秒；背景：粉紅雜訊，或四段日文朗讀疊在一起加起伏的雜訊（模擬觀眾和遊戲聲）。第 13 節。
用法：CUDA_VISIBLE_DEVICES= host/.venv/bin/python -I docs/research/tab-transcription/bench_noise_cut.py
"""
# 切點品質：切的那一塊在乾淨講話裡是不是停頓（乾淨 RMS 低於講話音量的 12%）。
import numpy as np
from faster_whisper import decode_audio
R = 16000; B = 1600
C = str(__import__('pathlib').Path(__file__).resolve().parent / 'corpus') + '/'
rng = np.random.default_rng(0)
def pink(n):
    w = rng.standard_normal(n); f = np.fft.rfft(w); f[1:] /= np.sqrt(np.arange(1, len(f))); x = np.fft.irfft(f, n); return x / np.std(x)
other = decode_audio(C + 'gongitsune-01.mp3', sampling_rate=R)[:120 * R]
def crowd(n):
    x = sum(np.roll(other, rng.integers(R * 5, R * 60)) for _ in range(4))[:n]; x = x / np.std(x)
    env = 0.6 + 0.4 * np.sin(np.arange(n) / R * 2 * np.pi / 7) + 0.3 * (rng.random(n // R + 1).repeat(R)[:n] > 0.85)
    y = (x + pink(n)) * env; return y / np.std(y)
def rmsblocks(x): return np.sqrt(np.mean(x[:len(x) // B * B].reshape(-1, B) ** 2, axis=1))
def chunks(pcm, k=None, maxb=250):
    r = rmsblocks(pcm); speech = 0.0; loud = []; cuts = []; start = 0; silent = 0
    for i, rms in enumerate(r):
        th = max(0.003, speech * 0.12)
        if k: th = max(th, np.percentile(r[max(0, i - 100):i + 1], 10) * k)
        l = rms > th
        if l: speech = speech * 0.95 + rms * 0.05
        silent = 0 if l else silent + 1
        loud.append(l); n = i + 1 - start
        if not any(loud[start:]):
            if n > 5: start = i + 1 - 5
        elif n >= 60 and silent >= 4: cuts.append((start, i + 1, sum(loud[start:i + 1]) >= 3)); start = i + 1
        elif n >= maxb:
            cut = i + 1 - 30
            for j in range(cut, i + 1):
                if r[j] < r[cut]: cut = j
            cuts.append((start, cut + 1, sum(loud[start:cut + 1]) >= 3)); start = cut + 1
    return cuts
def report(label, sp_r, cuts):
    sent = np.zeros(len(sp_r), bool)
    for a, b, ok in cuts:
        if ok: sent[a:b] = True
    voiced = sp_r > np.median(sp_r[sp_r > 0.01]) * 0.12
    cover = sent[voiced].mean()
    cuts = [(a, b) for a, b, ok in cuts]
    lens = [(b - a) / 10 for a, b in cuts]
    lvl = np.median(sp_r[sp_r > 0.01]); good = sum(sp_r[max(0, b - 3):b + 1].min() < lvl * 0.12 for a, b in cuts)
    return f'{label}: n={len(lens):2d} median={np.median(lens):4.1f}s max={max(lens):4.1f}s  cuts in a pause {good}/{len(cuts)}  speech sent {cover:.0%}'
for src, sl in (('alice', slice(60 * R, 180 * R)),):
    sp = decode_audio(C + 'alice-one-syllable-ch02.mp3', sampling_rate=R)[sl]
    sp_r = rmsblocks(sp); s_rms = np.sqrt(np.mean(sp ** 2))
    cases = [('clean', None, None)] + [(n, g, s) for n, g in (('pink', pink), ('crowd', crowd)) for s in (10, 5, 2, 0, -3)]
    for name, gen, snr in cases:
        mix = sp if gen is None else sp + gen(len(sp)) * s_rms / 10 ** (snr / 20)
        mix = (mix / max(1, np.abs(mix).max())).astype(np.float32)
        tag = name if snr is None else f'{name} {snr}dB'
        print(f'--- {tag}')
        for label, kw in (('now     ', {}), ('floor1.5', {'k': 1.5}), ('floor1.3', {'k': 1.3})):
            print('   ', report(label, sp_r, chunks(mix, **kw)))
