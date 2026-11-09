# Jerry

Jerry, a simple programming environment for the Elephant Robotics ultraArm P340, used during a workshop at Hong Kong Design Institute.

Supports joint/cartesian jogging, TCP/base coordinate systems, joint/cartesian moves, waypoint capture and editing, wait, loops. Programs are saved to a flat-file db and reloaded via a URL GUID, with versioning.

![Jerry](docs/screenshot.webp)

## Run

Deploy on a LAMP server with HTTPS to have a simple personal virtual programming environment that can directly control the ultraArm P340 with Web Serial.

- **Production:** copy the folder to a LAMP server (PHP 7.4+) with HTTPS. `db/` must be writable by Apache.
- **Local:** `python3 dev_server.py` → http://localhost:8340 (stands in for `api.php`).

The robot connects over Web Serial, which needs Chrome or Edge on HTTPS or localhost. Click **+ Port**, pick the arm's USB serial port, then **Open** (115200 baud).

## Files

| | |
|---|---|
| `index.html` | UI layout and styles |
| `js/main.js` | program tree, properties, jogging, executor, save/load |
| `js/scene.js` | three.js scene, arm model, waypoints, gizmo, path preview |
| `js/kin.js` | forward/inverse kinematics and arm dimensions |
| `js/serial.js` | Web Serial + ultraArm G-code protocol |
| `api.php` | storage: `db/<guid>/<version>.json` |

## License

MIT © AATB GmbH. See [LICENSE](LICENSE).

---

Developed with [Claude Code](https://claude.com/claude-code).
