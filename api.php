<?php
// Flat-file program storage, every save is a new immutable version: db/<guid>/<version>.json
// POST api.php[?id=<guid>]       body = program json -> {"id": "<guid>", "v": <version>}  (new guid if none given)
// GET  api.php?id=<guid>[&v=<n>] -> program json (latest version if v omitted)
header('Content-Type: application/json');
$db = __DIR__ . '/db';

function fail($code, $msg) { http_response_code($code); exit(json_encode(['error' => $msg])); }
function versions($dir) { $v = array_map(fn($f) => (int)basename($f, '.json'), glob("$dir/*.json") ?: []); sort($v); return $v; }

$id = $_GET['id'] ?? '';
if ($id !== '' && !preg_match('/^[0-9a-f-]{36}$/', $id)) fail(400, 'bad id');

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $body = file_get_contents('php://input');
  if (strlen($body) > 1000000 || json_decode($body) === null) fail(400, 'bad json');
  if ($id === '') {
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    $id = vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
  }
  $dir = "$db/$id";
  if (!is_dir($dir)) mkdir($dir, 0775, true);
  $vs = versions($dir);
  $v = ($vs ? end($vs) : 0) + 1;
  while (!($fh = @fopen("$dir/$v.json", 'x'))) $v++;   // never overwrite, even with concurrent saves
  fwrite($fh, $body); fclose($fh);
  exit(json_encode(['id' => $id, 'v' => $v]));
}

$dir = "$db/$id";
$all = $id ? versions($dir) : [];
if (!$all) fail(404, 'not found');
$v = isset($_GET['v']) ? (int)$_GET['v'] : end($all);
if (!is_file("$dir/$v.json")) fail(404, 'version not found');
header('X-Version: ' . $v);
header('X-Latest-Version: ' . end($all));
readfile("$dir/$v.json");
