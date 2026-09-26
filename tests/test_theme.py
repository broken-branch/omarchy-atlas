"""Theme route and authored reader colour audit."""

from __future__ import annotations

import http.client
import re
import tempfile
import threading
import unittest
from pathlib import Path

import atlas_serve


ROOT = Path(__file__).resolve().parents[1]
THEMES = ROOT / "tests/fixtures/theme"
NAMED = "transparent black white red green blue gray grey yellow orange purple pink cyan magenta brown silver gold navy teal lime olive maroon aqua fuchsia rebeccapurple".split()
COLOUR = re.compile(r"(?i)#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*(?:[\d.]|srgb\b)|\b(?:" + "|".join(NAMED) + r")\b")
FALLBACK = re.compile(r"var\(--[\w-]+,\s*(?:transparent|black|white|red|green|blue|gray|grey|#[0-9a-fA-F]{3,8})\s*\)")
MIX = re.compile(r"(?i)\bcolor-mix\(")
VARIABLE = re.compile(r"var\([^()]*\)")

def colour_hits(name: str, text: str) -> list[str]:
    """Colour literals outside var() fallbacks. A named colour counts only as a
    value: after a colon, comma, paren or quote, and before ; , ) ! or a quote
    (or the end of the line), never inside a selector or custom-property name."""
    hits = []
    for line_number, line in enumerate(FALLBACK.sub("", text).splitlines(), 1):
        mixes = list(MIX.finditer(line))
        for index, mix in enumerate(mixes):
            end = mixes[index + 1].start() if index + 1 < len(mixes) else len(line)
            literal = VARIABLE.sub("", line[mix.end():end].split(";", 1)[0])
            if COLOUR.search(literal):
                hits.append(f"{name}:{line_number}: color-mix(")
        for match in COLOUR.finditer(line):
            value = match.group()
            if value[0].isalpha() and "(" not in value:
                before, after = line[:match.start()], line[match.end():]
                if not (re.search(r"[:,('\"]\s*$", before) and re.match(r"\s*(?:[;,)!'\"]|$)", after)):
                    continue
            hits.append(f"{name}:{line_number}: {value}")
    return hits

class ThemeTests(unittest.TestCase):
    def test_theme_css_uses_each_fixture_palette(self) -> None:
        for name, background, foreground, accent in (
            ("dark", "#142133", "#e6efff", "#8ab4f8"),
            ("light", "#f5f1e8", "#242934", "#365bac"),
            ("sparse", "#dfd8ca", "#25201b", "#89b4fa"),
        ):
            with self.subTest(theme=name), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                server = atlas_serve.create_server(
                    port=0, config_path=base / "config.json", cache_path=base / "cache.json",
                    reader_dir=ROOT / "reader", theme_dir=THEMES / name,
                    shell_override_path=base / "absent.toml", rounding_command=None,
                )
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                try:
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=3)
                    connection.request("GET", "/theme.css",
                                       headers={"Authorization": "Bearer " + server.state.secret.hex()})
                    response = connection.getresponse()
                    css = response.read().decode()
                    connection.close()
                    self.assertEqual(response.status, 200)
                    self.assertIn(f"--background: {background};", css)
                    self.assertIn(f"--foreground: {foreground};", css)
                    self.assertIn(f"--accent: {accent};", css)
                    self.assertIn(f"--color-0: {background};", css)
                    self.assertIn("--control-fill:", css)
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

    def test_a_theme_without_orange_mixes_its_own_red_and_yellow(self) -> None:
        # Recency's "edited today" colour must come from the theme, not the fallback palette.
        mixed = atlas_serve._theme_css({"red": "#ff0000", "yellow": "#ffff00"}, {}, "0")
        own = atlas_serve._theme_css({"red": "#ff0000", "yellow": "#ffff00", "orange": "#123456"}, {}, "0")
        self.assertEqual(("--orange: #ff7f00;" in mixed, "--orange: #123456;" in own), (True, True))

    def test_reader_authored_styles_have_no_fixed_colours(self) -> None:
        hits = []
        for path in sorted((ROOT / "reader").iterdir()):
            if path.suffix in {".css", ".js"}:
                hits += colour_hits(path.name, path.read_text(encoding="utf-8"))
        self.assertEqual(hits, [])

    def test_colour_audit_catches_named_hex_and_function_colours(self) -> None:
        source = ("a { background: red; }\n"
                  ".red { color: var(--red, #fff); }\n"
                  "b { border-color: #123456; color: rgb(1, 2, 3) }\n"
                  "const tint = 'blue';\n"
                  "c { color: RGB(1 2 3 / .5); background: hwb(10 20% 30%); }\n"
                  "d { color: lab(50% 2 3); background: oklch(50% .2 20); }\n"
                  "e { color: color-mix(in srgb, var(--accent), #fff); background: color-mix(in srgb, RED 50%, var(--accent)); }\n"
                  "f { color: WHITE; background: color(srgb 1 0 0); }\n")
        self.assertEqual(colour_hits("x.css", source),
                         ["x.css:1: red", "x.css:3: #123456", "x.css:3: rgb(1", "x.css:4: blue",
                          "x.css:5: RGB(1", "x.css:5: hwb(1", "x.css:6: lab(5", "x.css:6: oklch(5",
                          "x.css:7: color-mix(", "x.css:7: color-mix(", "x.css:7: #fff", "x.css:8: WHITE", "x.css:8: color(srgb"])
