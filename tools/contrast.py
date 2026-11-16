#!/usr/bin/env python3
"""Print the WCAG 2 contrast ratio for each colour pair that DESIGN.md uses.

Run: python3 tools/contrast.py
Update COLOURS and PAIRS when a colour in DESIGN.md changes, then copy the
output into DESIGN.md section 3.4. Exit code 1 if a pair is below its minimum.
"""
import sys

COLOURS = {
    "ink": "#10263b", "gold": "#f5b82e", "gold-wash": "#fdf3d7",
    "paper": "#ffffff", "mist": "#f5f5f5", "charcoal": "#454745",
    "slate": "#6a6c6a", "pebble": "#868685", "silver": "#bdbdbd",
    "error": "#cb272f",
}

# (foreground, background, minimum ratio)
PAIRS = [
    ("ink", "paper", 4.5), ("ink", "mist", 4.5), ("ink", "gold-wash", 4.5),
    ("ink", "gold", 4.5), ("gold", "ink", 4.5), ("paper", "ink", 4.5),
    ("silver", "ink", 4.5), ("charcoal", "paper", 4.5),
    ("charcoal", "mist", 4.5), ("charcoal", "gold-wash", 4.5),
    ("slate", "paper", 4.5), ("slate", "mist", 4.5),
    ("slate", "gold-wash", 4.5), ("error", "paper", 4.5),
    ("error", "mist", 4.5), ("pebble", "paper", 3.0),
]


def luminance(hex_value):
    h = hex_value.lstrip("#")
    channels = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
           for c in channels]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def ratio(a, b):
    hi, lo = sorted([luminance(a), luminance(b)], reverse=True)
    return (hi + 0.05) / (lo + 0.05)


failed = False
for fg, bg, minimum in PAIRS:
    r = ratio(COLOURS[fg], COLOURS[bg])
    ok = r >= minimum
    failed = failed or not ok
    print(f"{fg:9s} on {bg:9s} {r:5.2f}  min {minimum}  {'pass' if ok else 'FAIL'}")
sys.exit(1 if failed else 0)
