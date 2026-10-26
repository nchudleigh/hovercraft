"""Render the X promo video: title card, demo clip, end card, over a music track."""
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DEMO = ROOT / "docs/media/demo.mp4"
OUT = ROOT / "docs/media/promo.mp4"
AUDIO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Development/hardware-track/out/hardware-track.mp3"
WORK = ROOT / "dist/promo"

W = H = 1080
BG = (10, 11, 13)
FG = (231, 233, 234)
MUTED = (139, 152, 165)
FONT = "/System/Library/Fonts/SFNS.ttf"

# Track is 136 BPM; cut on bar lines, landing the demo on the chorus drop.
BAR = 4 * 60 / 136
CHORUS_AT = 32 * BAR
TITLE_S, DEMO_S, END_S = BAR, 8 * BAR, 2 * BAR
DEMO_FROM = 0.7

# Demo crop: drop X's left nav, keep the notifications column.
CROP = (400, 0, 880, 750)
DEMO_W = 1000
DEMO_H = round(DEMO_W * CROP[3] / CROP[2])
DEMO_X, DEMO_Y = (W - DEMO_W) // 2, H - DEMO_H - 24
RADIUS = 28


def font(size, weight):
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_axes([100, min(size, 96), 400, weight])  # width, optical size, grade, weight
    return f


def centered(d, y, text, f, fill):
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)


def card(path, lines):
    img = Image.new("RGB", (W, H), BG)
    icon = Image.open(ROOT / "icons/icon128.png").convert("RGBA").resize((176, 176), Image.LANCZOS)
    img.paste(icon, ((W - 176) // 2, 300), icon)
    d = ImageDraw.Draw(img)
    centered(d, 510, "Hovercraft", font(112, 700), FG)
    for i, line in enumerate(lines):
        centered(d, 660 + i * 58, line, font(44, 400), MUTED)
    img.save(path)


def demo_bg(path):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    centered(d, 30, "No wait. No fade.", font(56, 700), FG)
    centered(d, 100, "Glides between profiles.", font(56, 700), MUTED)
    box = (DEMO_X - 2, DEMO_Y - 2, DEMO_X + DEMO_W + 1, DEMO_Y + DEMO_H + 1)
    d.rounded_rectangle(box, RADIUS + 2, fill=(47, 51, 54))
    img.save(path)


def mask(path):
    m = Image.new("L", (DEMO_W, DEMO_H), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, DEMO_W - 1, DEMO_H - 1), RADIUS, fill=255)
    m.save(path)


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    card(WORK / "title.png", ["Instant profile cards for X."])
    card(WORK / "end.png", ["Free Chrome extension", "github.com/nchudleigh/hovercraft"])
    demo_bg(WORK / "demo_bg.png")
    mask(WORK / "mask.png")

    total = TITLE_S + DEMO_S + END_S
    cx, cy, cw, ch = CROP
    fade = 0.25
    graph = ";".join([
        f"[0:v]loop=-1:1,trim=duration={TITLE_S},setpts=PTS-STARTPTS,fps=30,format=yuv420p,"
        f"fade=in:d={fade}[title]",
        f"[1:v]loop=-1:1,trim=duration={DEMO_S},setpts=PTS-STARTPTS,fps=30[bg]",
        f"[2:v]trim=start={DEMO_FROM}:duration={DEMO_S},setpts=PTS-STARTPTS,fps=30,"
        f"crop={cw}:{ch}:{cx}:{cy},scale={DEMO_W}:{DEMO_H}:flags=lanczos,format=rgba[clip]",
        "[3:v]format=gray[m]",
        "[clip][m]alphamerge[rounded]",
        f"[bg][rounded]overlay={DEMO_X}:{DEMO_Y}:shortest=1,format=yuv420p[demo]",
        f"[4:v]loop=-1:1,trim=duration={END_S},setpts=PTS-STARTPTS,fps=30,format=yuv420p,"
        f"fade=out:st={END_S - 0.6}:d=0.6[end]",
        "[title][demo][end]concat=n=3:v=1:a=0,setsar=1[v]",
        f"[5:a]atrim=start={CHORUS_AT - TITLE_S}:duration={total},asetpts=PTS-STARTPTS,"
        f"afade=in:d=0.05,afade=out:st={total - 1.5}:d=1.5[a]",
    ])
    subprocess.run([
        "ffmpeg", "-v", "error", "-y",
        "-i", WORK / "title.png", "-i", WORK / "demo_bg.png", "-i", DEMO,
        "-loop", "1", "-i", WORK / "mask.png", "-i", WORK / "end.png", "-i", AUDIO,
        "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", f"{total:.3f}", OUT,
    ], check=True)
    print(OUT)


if __name__ == "__main__":
    main()
