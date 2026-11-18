# ASCII space portfolio

A portfolio site where everything is a real-time 3D scene drawn as text characters.
Hover a planet and it locks on. Click it and the ship flies there, leaving a smoke trail.
The camera follows, and that planet's info panel opens. Press Esc (or click anywhere) to fly back.

It is plain HTML/CSS/JS with no build step and no dependencies. It needs WebGL2, which
every current browser has.

## Run it

Double-click `index.html`, or serve the folder:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## Edit your content

Everything you write lives in **`content.js`**: your name, and one entry per planet
(label, look, and the HTML shown in the panel). The planet looks are `terra`, `gas` (add `rings: true`),
`ice`, `lava` and `moon`. You can have up to 6 planets, and their order sets where they sit in space.

Deep links work. `index.html#work` opens straight onto that planet.

## Files

| file | what |
|---|---|
| `content.js` | your text and links |
| `app.js` | renderer, scene, ship, smoke, interaction |
| `style.css` | HUD, labels, info panel |

## How the ASCII works

1. **Scene pass:** a shader ray-traces the planets, ray-marches the ship (a signed distance field)
   and renders the smoke puffs, at 3x3 samples per character cell.
2. **Cell pass:** for each cell it picks the character whose *shape* best matches those 9 samples.
   That is why edges get `/ \ | _ ( )` instead of blurry blobs. Flat areas use the classic
   ` .:-=+*#%@` ramp.
3. **Composite pass:** draws the chosen glyphs from a font atlas, plus a soft glow.

If the frame rate drops below about 30fps, the page automatically switches to bigger characters.

## Debug views

- `?raw=1` shows the underlying 3D render instead of characters.
- `?sim=4&go=1` jumps 4 seconds into a flight to planet 2. `&hover=0` previews hover, and
  `&back=5` starts the trip home at 5s.

## Deploy

Live at **https://maartenstork.com** (GitHub Pages, from the `main` branch; DNS at Hostnet).
To update the site, commit and push. GitHub rebuilds it in about a minute:

```sh
git add -A && git commit -m "Update content" && git push
```

To use your own domain later, add it under the repo's Settings > Pages > Custom domain
and point a CNAME DNS record at `maartenstork.github.io`.

## Portrait and logos

- Portrait: `tools/cutout.swift` cuts you out of a photo (macOS Vision), then
  `python3 tools/make-portrait.py PHOTO --mask mask.png --face face.json` writes `portrait.js`.
- Logos: put a crop on white in `tools/logos/NAME.png`, run `python3 tools/make-logos.py`,
  then add `data-logo="NAME"` to the entry in `content.js`.
