# BeeSlides brand kit

The logo and the start-up animation, ready to share. Everything here is
generated. Don't edit these files; rerun the export instead:

```sh
node scripts/export-brand-kit.mjs
```

The sources are `slides/src/brand.ts` (the mark, colours) and the boot splash
in `slides/index.html` (the animation). See the script's header for its
requirements (ffmpeg, playwright-core).

![The BeeSlides start-up animation](beeslides-intro.gif)

## Logo

| File | What |
| --- | --- |
| `beeslides-logo.svg` | The logo on its dark tile, vector |
| `beeslides-logo-1024.png`, `-512.png`, `-256.png` | The same, transparent corners |
| `beeslides-mark-1024.png` | The record and bee alone, no tile, for your own background |
| `beeslides-lockup-on-dark.png` | Logo + "BeeSlides" wordmark, for dark backgrounds (transparent) |
| `beeslides-lockup-on-light.png` | Logo + "BeeSlides" wordmark, for light backgrounds (transparent) |

## Animation

The intro from the app's start-up screen (the bee flies in, drops its needle,
the record spins, sound rings pulse out), 5 seconds, fading out at the end so
it loops cleanly.

| File | What |
| --- | --- |
| `beeslides-intro-1920x1080.mp4` | 16:9, 60 fps: slides, videos, screen shares |
| `beeslides-intro-1080x1080.mp4` | Square, 50 fps: social posts, chat |
| `beeslides-intro.gif` | Square, 480 px, 25 fps, looping: READMEs, chat, anywhere video won't play |
| `beeslides-poster-1920x1080.png` | The settled frame: thumbnail, link preview |
