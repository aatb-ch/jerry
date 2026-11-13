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
const rand = (a, b) => a + Math.random() * (b - a);

// pick an image no layer is showing (this one included, so it really changes), if there are enough images
function pick() {
  const shown = layers.map(l => l.dataset.src);
  const free = imgs.filter(i => !shown.includes(i));
  const pool = free.length ? free : imgs;
  return pool[Math.floor(Math.random() * pool.length)];
}

// each layer swaps its image on its own random clock, every 3–10 s (preloaded, faded out, swapped, faded in)
function swap(layer) {
  const src = imgs.length && pick();
  empty.hidden = imgs.length > 0;
  if (!src) return setTimeout(() => swap(layer), 3000);
  layer.dataset.src = src; // claimed now, so another layer doesn't pick it during the fade
  const next = new Image();
  next.onload = next.onerror = () => {
    layer.classList.add('out');
    setTimeout(() => {
      layer.src = next.src;
      layer.classList.toggle('out', !next.width);
      setTimeout(() => swap(layer), rand(2000, 9000)); // + 1 s fade = a new image every 3–10 s
    }, 1000);
  };
  next.src = 'img/' + encodeURIComponent(src);
}
layers.forEach((l, i) => setTimeout(() => swap(l), i * 700));

// new images dropped on the server show up within a minute
setInterval(() => fetch('?list').then(r => r.json()).then(l => { imgs = l; }).catch(() => {}), 60000);

// click / key: toggle full screen
const fs = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
addEventListener('click', fs);
addEventListener('keydown', e => { if (e.key === 'f' || e.key === ' ') fs(); });
</script>
</body>
</html>
