<?php
// Workshop results slideshow: every image dropped in results/img/ is picked up automatically.
// ?list -> JSON array of image file names (the page re-reads it every minute, so new images show up without a reload)
$imgs = array_values(array_map('basename', glob(__DIR__ . '/img/*.{jpg,jpeg,png,gif,webp,svg,JPG,JPEG,PNG,GIF,WEBP,SVG}', GLOB_BRACE) ?: []));
if (isset($_GET['list'])) { header('Content-Type: application/json'); exit(json_encode($imgs)); }
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jerry – workshop results</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🐭</text></svg>">
<style>
  html, body { margin: 0; height: 100%; background: #fff; overflow: hidden; cursor: none; }
  /* two full-screen layers on top of each other, multiplied: white stays white, the drawings mix */
  .layer { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: contain; object-position: center;
           mix-blend-mode: multiply; transition: opacity 1s; }
  .layer.out { opacity: 0; }
  #empty { position: fixed; inset: 0; display: grid; place-items: center; font: 16px system-ui, sans-serif; color: #999; }
  #empty[hidden] { display: none; }
</style>
</head>
<body>
<img class="layer out" alt="">
<img class="layer out" alt="">
<div id="empty" hidden>No images yet – drop them in results/img/</div>
<script>
let imgs = <?= json_encode($imgs) ?>;
const layers = [...document.querySelectorAll('.layer')], empty = document.getElementById('empty');
const ALONE = 5000, TOGETHER = 5000, FADE = 1000; // ms (FADE = the CSS opacity transition)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// shuffled deck: every image once per round, no image twice in a row across rounds
let deck = [], prev = null;
function next() {
  if (!deck.length) {
    deck = imgs.filter(i => i !== prev).sort(() => Math.random() - 0.5);
    if (!deck.length) deck = [...imgs];
  }
  return prev = deck.pop();
}
const load = src => new Promise(r => { const i = new Image(); i.onload = i.onerror = () => r(i); i.src = 'img/' + encodeURIComponent(src); });

// sequence: A alone → A + B overlapping → B alone → B + C → C alone → …
// two layers take turns: the hidden one fades in with the next image, then the old one fades out
async function play() {
  let [cur, nxt] = layers;
  for (;;) {
    empty.hidden = imgs.length > 0;
    if (!imgs.length) { await sleep(3000); continue; }
    const img = await load(next()); // preloaded, so the fade starts with the image ready
    nxt.src = img.src;
    nxt.classList.remove('out');
    const overlap = cur.hasAttribute('src') && !cur.classList.contains('out');
    await sleep(FADE + (overlap ? TOGETHER : 0));
    cur.classList.add('out');
    await sleep(FADE + ALONE);
    [cur, nxt] = [nxt, cur];
  }
}
play();

// new images dropped on the server show up within a minute
setInterval(() => fetch('?list').then(r => r.json()).then(l => { imgs = l; }).catch(() => {}), 60000);

// reload every 5 min to pick up a new version of this page; only when the server answers, so a network
// hiccup never leaves the beamer on a browser error page (run the browser in kiosk mode to stay full screen)
setInterval(() => fetch('?list', { cache: 'no-store' }).then(r => r.ok && location.reload()).catch(() => {}), 5 * 60000);

// click / key: toggle full screen
const fs = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
addEventListener('click', fs);
addEventListener('keydown', e => { if (e.key === 'f' || e.key === ' ') fs(); });
</script>
</body>
</html>
