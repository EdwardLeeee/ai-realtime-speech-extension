"""量本機翻譯模型（llama.cpp llama-server，模型全放 GPU）把英文／日文句子翻成繁體中文的速度與品質。

用法：python3 docs/research/tab-transcription/bench_translate.py <llama-server 路徑> <模型.gguf> [--prompt hymt|chat] [--ngl 99] [--ctx 4096] [--temperature 0.7]
  hymt：騰訊 Hy-MT2 模型卡建議的中文提示（將以下文本翻译为繁体中文…）
  chat：一般指令模型用的提示
  --ngl：放到顯示卡的層數，0 表示全部用 CPU；--ctx：llama-server 的 context 長度（影響顯示記憶體）
  --temperature：模型卡建議 0.7；0 是每次都選機率最高的字，同一句每次翻得一樣
"""

import argparse
import json
import socket
import statistics
import subprocess
import time
import urllib.request

# 英文：Whisper 實際轉出的句子（Alice）＋ TOEFL 講課風格；日文：Whisper 實際轉出的《ごんぎつね》（含辨識錯字）；
# 泰文：large-v3-turbo 轉 FLEURS 泰文的結果（含辨識錯字），對照的中文參考譯文在 THAI_REFERENCES
SENTENCES = {
    "en": [
        "They must go by the mail, she thought, and how funny it'll seem to send shoes to one's own feet, how odd the address will look.",
        "Just then her head struck the roof of the hall, in fact she was now more than nine feet high, and she at once took up the small key and went back to the door.",
        "But to get through was not to be hoped for, so she sat down and had a good cry.",
        "So the professor argues that the decline in bee populations is mainly caused by habitat loss rather than pesticides, although both factors play a role.",
        "For the midterm, you'll need to read chapters three through five, and I'd strongly recommend going over your lab notes as well.",
    ],
    "ja": [
        "なたね柄の干してあるのへ火をつけたり 百姓屋の裏手につるしてある トンガラシをむしりとっていったりいろんなことをしました",
        "ある 秋のことでした 2,3日 雨が降り続いたその間",
        "ゴンは外へも出られなくて 穴の中にしゃがんでいました",
        "空はカラッと晴れていて モズの声がキンキン響いていました",
    ],
    "th": [
        "ในที่สุดล้อเหล็กก็มาแทนที่ล้อหมายและในปี 1767 ก็มีการใช้รางเหล็กหลวนเป็นครั้งแรก",
        "สิ่งนี้กลายเป็นวิธีปฏิบัติที่ใช้โดยทั่วไป แต่เล็กทำให้ล้อไม้ของเกลียนเกิดการศึกหลอยิ่งกว่าเดิม",
        "ระเบิดใกล้สถานที่ราชการอีก 3 ลูกถูกประทักขึ้นในช่วงเวลา 2 ชั่วโมง",
        "มีการวางแผนที่จะโค้นในวันอังคาร แต่สารมีคำสั่งเป็นการเร่งดวนให้เก็บรักษาไว้",
        "ด้วยอย่างของกิจกรรมในสถานที่ได้แก่การล่าศัทธ์ตกปลาถ่ายภาพดูนกเที่ยวชมสวน และศึกษาข้อมูลเกี่ยวกับระปบนิเวท",
        "หากต้องการแก้ไขหรือร้องขอสิ่งใด ควรดำเนินการผ่านตัวแถนการท่องเที่ยวไม่ควรติดต่อไปที่โรงแรมโดยตรง",
    ],
}
# FLEURS cmn_hans_cn 同一句的人工中文（簡體），只用來人工對照意思
THAI_REFERENCES = [
    "最终，木轮被铁轮所取代。1767 年，第一条全铁轨道问世。",
    "这成了普遍做法，但铁片会使木制的马车轮子磨损更严重。",
    "两小时内，政府大楼附近又发生了三起炸弹爆炸事件。",
    "按照原计划，它将在周二被砍倒，但在法庭紧急裁决后幸免遇难。",
    "现场活动包括打猎、钓鱼、摄影、观鸟、参观公园和研究生态系统。",
    "如果需要进行任何修改或有任何要求，应该首先通过旅行代理商进行办理，而不是直接与酒店接洽。",
]

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def post(port, payload):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def prompt_for(style, text):
    if style == "hymt":
        return f"将以下文本翻译为繁体中文，注意只需要输出翻译后的结果，不要额外解释：\n\n{text}"
    return f"把下面這段話翻譯成台灣用語的繁體中文，只輸出譯文，不要解釋：\n\n{text}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("server")
    ap.add_argument("model")
    ap.add_argument("--prompt", default="hymt", choices=["hymt", "chat"])
    ap.add_argument("--ngl", default="99")
    ap.add_argument("--ctx", default="4096")
    ap.add_argument("--temperature", type=float, default=0.7)
    args = ap.parse_args()

    port = free_port()
    t0 = time.perf_counter()
    proc = subprocess.Popen(
        [args.server, "-m", args.model, "-ngl", args.ngl, "--port", str(port), "-c", args.ctx, "--jinja"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(600):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as r:
                    if r.status == 200:
                        break
            except Exception:
                time.sleep(0.2)
        load = time.perf_counter() - t0
        rows = []
        for lang, items in SENTENCES.items():
            for text in items:
                t = time.perf_counter()
                out = post(port, {
                    "messages": [{"role": "user", "content": prompt_for(args.prompt, text)}],
                    "temperature": args.temperature, "top_p": 0.6, "top_k": 20, "repeat_penalty": 1.05,
                    "max_tokens": 256,
                })
                rows.append({
                    "lang": lang,
                    "seconds": round(time.perf_counter() - t, 2),
                    "tokens": out.get("usage", {}).get("completion_tokens"),
                    "source": text,
                    "translation": out["choices"][0]["message"]["content"].strip(),
                })
        secs = [r["seconds"] for r in rows]
        summary = {
            "model": args.model.rsplit("/", 1)[-1],
            "prompt": args.prompt,
            "ngl": args.ngl,
            "ctx": args.ctx,
            "temperature": args.temperature,
            "load_s": round(load, 1),
            "median_s": round(statistics.median(secs), 2),
            "max_s": max(secs),
        }
        print(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
