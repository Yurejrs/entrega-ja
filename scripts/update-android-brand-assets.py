#!/usr/bin/env python3
"""Generate Android launcher and splash resources from the mobile brand assets."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "apps/mobile/assets"
RES = ROOT / "apps/mobile/android/app/src/main/res"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
RESAMPLE = Image.Resampling.LANCZOS


def save_icon(source: Image.Image, destination: Path, size: int, round_icon: bool) -> None:
    icon = source.resize((size, size), RESAMPLE).convert("RGBA")
    if round_icon:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        icon.putalpha(mask)
    destination.parent.mkdir(parents=True, exist_ok=True)
    icon.save(destination, "WEBP", quality=100, lossless=True)


def main() -> None:
    icon = Image.open(ASSETS / "icon.png")
    splash = Image.open(ASSETS / "splash-logo.png")
    foreground = Image.open(ASSETS / "adaptive-foreground.png")
    for density, scale in DENSITIES.items():
        mipmap = RES / f"mipmap-{density}"
        size = round(48 * scale)
        save_icon(icon, mipmap / "ic_launcher.webp", size, False)
        save_icon(icon, mipmap / "ic_launcher_round.webp", size, True)
        splash_size = round(288 * scale)
        splash.resize((splash_size, splash_size), RESAMPLE).save(
            RES / f"drawable-{density}" / "splashscreen_logo.png"
        )

    foreground_dir = RES / "drawable-nodpi"
    foreground_dir.mkdir(parents=True, exist_ok=True)
    foreground.save(foreground_dir / "ic_launcher_foreground.png")
    adaptive_dir = RES / "mipmap-anydpi-v26"
    adaptive_dir.mkdir(parents=True, exist_ok=True)
    adaptive_xml = """<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/launcher_background" />
  <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
"""
    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        (adaptive_dir / name).write_text(adaptive_xml)


if __name__ == "__main__":
    main()
