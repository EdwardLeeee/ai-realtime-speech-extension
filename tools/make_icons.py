"""產生插件圖示：藍底圓角方塊，左邊聲波、右邊文字行。用法：python3 tools/make_icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
SCALE = 8  # 先畫大圖再縮小，邊緣比較平滑


def draw(size):
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=(37, 99, 235, 255))
    white = (255, 255, 255, 255)
    bar_w = s * 0.075
    for i, h in enumerate([0.22, 0.46, 0.30]):
        x = s * 0.17 + i * s * 0.12
        d.rounded_rectangle([x, s * (0.5 - h / 2), x + bar_w, s * (0.5 + h / 2)], radius=bar_w / 2, fill=white)
    for i, w in enumerate([0.30, 0.22, 0.27]):
        y = s * 0.34 + i * s * 0.14
        d.rounded_rectangle([s * 0.56, y, s * (0.56 + w), y + s * 0.07], radius=s * 0.035, fill=white)
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 128):
    draw(size).save(OUT / f"icon{size}.png")
print("icons ->", OUT)
