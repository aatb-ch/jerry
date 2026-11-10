# Jerry

Jerry, a simple online/offline programming environment for the Elephant Robotics ultraArm P340, used during a workshop at Hong Kong Design Institute. This tool was developed to allow a whole class to experiment individually virtually on their projects, and connect periodically to real hardware, loading their own files easily from a shared library.

## Features

- Joint and Cartesian jogging, by buttons or by dragging the TCP gizmo
- TCP and base coordinate systems; tool offset from the flange (default: TCP at the flange)
- Waypoints: capture from the TCP, edit numerically or drag in 3D
- Program tree: MoveJ, MoveL, wait, loops, power on, home, release
- SVG plotting: load an SVG, place it with an anchor pose, set scale, approach height and speed
- Run on the virtual robot for preview, or on the real arm via Web Serial
- Path preview of the TCP trajectory
- Programs saved to a flat-file db, reloaded via a URL GUID, with versioning, to allow easy save/load from different machines (personal laptops for offline programming -> save -> on machine that is connected to real hardware load their own file -> run)

![Jerry](docs/screenshot.webp)
*Left pane: hardware control, scene save/load/new, base/TCP offset, program tree and editor. Right pane: jogging, node properties.*

![Shared library](docs/library.webp)
*Saved scenes show up in a shared library to easily load from a different machine with actual hardware, allowing easy prototyping offline, save and load for online playback.*

## Run

Deploy on a LAMP server with HTTPS to have a simple personal virtual programming environment that can directly control the ultraArm P340 with Web Serial.

- **Production:** copy the folder to a LAMP server (PHP 7.4+) with HTTPS. `db/` must be writable by Apache.
- **Local:** serve the folder with any local PHP stack such as [MAMP](https://www.mamp.info), with HTTPS enabled (Web Serial needs HTTPS or localhost). `db/` must be writable.

The robot connects over Web Serial, which needs Chrome or Edge on HTTPS or localhost. Click **+ Port**, pick the arm's USB serial port, then **Open** (115200 baud).

## Files

| | |
|---|---|
| `index.html` | UI layout and styles |
| `js/main.js` | program tree, properties, jogging, executor, save/load |
| `js/scene.js` | three.js scene, arm model, waypoints, gizmo, path preview |
| `js/kin.js` | forward/inverse kinematics and arm dimensions |
| `js/serial.js` | Web Serial + ultraArm G-code protocol |
| `js/svg.js` | SVG → simplified pen strokes in mm |
| `api.php` | storage: `db/<guid>/<version>.json` |

## License

MIT © AATB GmbH. See [LICENSE](LICENSE).

---

Developed with [Claude Code](https://claude.com/claude-code).
