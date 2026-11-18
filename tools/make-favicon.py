"""Make favicon.svg: a small blue ASCII stork.   python3 tools/make-favicon.py favicon.svg"""
import sys, html
# blue ASCII stork, facing right. 'b' = blue, 'o' = orange (beak, legs)
ART = [
    "         .-.   ",
    "        (@o>===",
    "         \\@    ",
    "          @|   ",
    "  .;%@@@@@@'   ",
    "<%@@@@@@@@@'   ",
    "  '%@@@@@%'    ",
    "      ||       ",
    "      ||       ",
    "     _/\\_      ",
]
ORANGE_ROWS = {7, 8, 9}
BLUE, BEAK, BG = "#5cb8ff", "#ff8a3d", "#05060c"
cols, rows = max(len(l) for l in ART), len(ART)
pad = 6
cw = (100 - 2 * pad) / cols          # character cell width
fs = cw / 0.6                          # monospace: advance = 0.6 em
lh = (100 - 2 * pad) / rows            # row height
out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
       f'  <rect width="100" height="100" rx="18" fill="{BG}"/>',
       f'  <g font-family="ui-monospace, Menlo, Consolas, monospace" font-size="{fs:.2f}" font-weight="700" text-anchor="middle">']
for r, line in enumerate(ART):
    y = pad + lh * (r + 0.78)
    for c, ch in enumerate(line):
        if ch == " ": continue
        beak = r == 1 and c >= line.index(">")
        col = BEAK if (beak or r in ORANGE_ROWS) else BLUE
        out.append(f'    <text x="{pad + cw * (c + 0.5):.2f}" y="{y:.2f}" fill="{col}">{html.escape(ch)}</text>')
out += ['  </g>', '</svg>']
open(sys.argv[1], "w").write("\n".join(out) + "\n")
