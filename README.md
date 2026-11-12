# Stillflow

Make still photos move. Draw arrows where things should flow, freeze the parts that should stay put, and export a loop that never visibly restarts. It runs in your browser and your photo never gets uploaded anywhere.

<!-- Put a demo GIF here. Easiest way: open the sample, Export > GIF, save it as docs/demo.gif -->
<!-- ![Stillflow turning a lake photo into a loop](docs/demo.gif) -->

Try it here: https://dazukee.github.io/stillflow/

## Why

You've probably seen these "living photos": a waterfall that keeps pouring, clouds sliding over a still city. The apps that make them are mostly phone-only or subscription-based, and some want your photos on their servers. I wanted one that opens in a browser tab, costs nothing, and keeps everything on your own machine, so I wrote it.

It's plain HTML, CSS and JavaScript with no dependencies and no build step, and it doesn't track anything.

## Using it

1. Open a photo. You can also drag one in or paste it with Ctrl+V. If you just want to see what it does, hit **Try the sample**.
2. Pick the motion tool and drag along the direction things should move. Water, clouds, smoke, steam and hair work best. Each path drags the area around it, as far as its reach.
3. Drop pins on things that have to stay sharp, like a horizon or a shoreline, and paint over people, buildings and rocks with the freeze brush.
4. Play with speed and loop length until it looks right, then export an MP4 or a GIF.

Hold the eye button (or `C`) at any point to compare with the original.

### Shortcuts

| Key | What it does |
| --- | --- |
| `V` | Select tool. Click a path or pin to change it, drag to move it. |
| `A` | Motion path |
| `P` | Pin |
| `F` | Freeze brush (hold `Alt` to erase) |
| `E` | Unfreeze brush |
| `[` `]` | Make the brush, pin or reach smaller or bigger |
| `Space` | Tap to play or pause, hold and drag to pan |
| `C` | Hold to see the original photo |
| `G` | Show or hide the guides |
| `0` | Fit to screen |
| `Delete` | Delete the selected path or pin |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |

Mouse wheel zooms, middle mouse pans. On a phone, use two fingers to zoom and pan.

### Getting good results

Things that flow without hard edges look best. Water, mist and clouds are great; a car or a person walking will just smear. Keep motion moderate: the faster something moves, the more the picture stretches before the loop resets it. If you see a "pulse" in the motion, try a longer loop. If things look stretched, try a shorter one.

Freeze generously around the edges of moving areas. A soft brush helps the moving part blend into the still part.

## How it works

The short version: every pixel looks back along the flow and grabs color from a little way upstream.

### The flow field

The paths, pins and freeze strokes you draw are stored as vectors (that's why undo is instant). When anything changes, `src/flowfield.js` turns them into a coarse grid of velocities. Each point along a path votes for its direction, weighted by a gaussian of the distance. Pins vote very loudly for "stay still", and every cell also gets one small vote for "stay still". Dividing by the total weight gives smooth motion that fades out away from your paths and never comes out faster than the paths that went into it.

### The animation

You can't keep pushing pixels along a flow forever or the image turns into soup. Games ran into this with flowing water and solved it with flow maps (Alex Vlachos' "Water Flow in Portal 2" talk from SIGGRAPH 2010 is the classic reference). The shader in `src/renderer.js` samples the photo some distance back along the flow, and that distance grows and then snaps back to zero. Two copies run half a cycle apart and crossfade, so the snap always happens on whichever copy is invisible at that moment. The lookup also walks through the field in a few small steps instead of one straight jump, so motion follows curved paths.

One detail took me a while to notice: since the two copies are identical apart from their offset, the picture repeats every half cycle. A loop of L seconds therefore uses a 2L second cycle, and frame 0 and frame N are the same image. That's what makes exported loops seamless.

A low-frequency noise texture shifts the timing slightly from area to area, so the whole photo doesn't pulse in sync.

### Exporting

Frames are rendered offscreen at exact times and sizes, not captured from the screen. MP4 export uses the browser's WebCodecs H.264 encoder, plus a small MP4 muxer I wrote for it (`src/mp4.js`). The GIF encoder (`src/gif.js`) is also hand-written. It builds one palette with median cut, uses ordered dithering so the dither pattern doesn't crawl from frame to frame, and stores only what changed between frames. Frozen areas never change, which saves a lot of space. Browsers without WebCodecs fall back to recording a WebM in real time.

## Running it locally

Clone the repo and open `index.html`. There's nothing to install.

If your browser complains about opening local files, serve the folder instead:

```bash
python -m http.server 8000
```

Then go to http://localhost:8000.

To put it online, push it to GitHub, open Settings > Pages, and pick "Deploy from a branch" with `main` and the root folder.

## Project layout

```
index.html        markup and icons
styles.css        all the styling
src/
  app.js          state, undo, render loop, panel and keyboard handling
  editor.js       pointer input, view transform, guide overlay
  flowfield.js    paths and pins to a velocity grid
  renderer.js     WebGL2 setup and the flow shader
  mask.js         paints the freeze strokes onto a canvas
  export.js       export dialog and the frame loop
  mp4.js          MP4 muxer for WebCodecs output
  gif.js          GIF encoder (median cut, LZW)
  sample.js       the procedural sample picture
  history.js      undo stack
  util.js         small helpers and value noise
```

## Browser support

Anything recent with WebGL 2 should work: Chrome, Edge, Firefox, Safari. MP4 export needs WebCodecs. Without it you get WebM, which takes as long to export as the video is.

## Known limitations

- Photos larger than 2048 px on the long side are scaled down when you open them.
- GIF export tops out at 800 px, because GIFs get huge fast.
- There's no way to save a project and keep editing it later yet.
- Large, fast motion over detailed areas ghosts. That's the nature of the technique.

## Ideas for later

- Save and load projects (the document is already small JSON)
- Automatic sky and water detection to suggest paths
- A smarter mask tool that snaps to edges
- Particle overlays like rain or snow

Issues and pull requests are welcome. If you make something nice with it, I'd love to see it.

## License

MIT. See [LICENSE](LICENSE).
