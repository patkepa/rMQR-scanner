# rMQR Binary Scanner

A browser-only rMQR scanner tailored for the device display code. It uses
ZXing-C++ WebAssembly to scan only `RMQRCode` symbols and displays the
decoder's raw `bytes` buffer, hexadecimal, Base64URL, decoded text, and parsed
device fields.

For PWM/row-scanned LED panels, the live scanner combines the brightest pixel
from four consecutive camera frames before decoding. This restores LED rows
that a rolling-shutter camera captured while they were off. Keep the phone
still for about one second while it collects the frames.

## device format

Current device firmware emits exactly six Base45 characters. They decode to
four little-endian packed display-state bytes: current/secondary state,
display-image flags, prior screen, Wi-Fi and cloud connectivity, and whether
custom text is enabled. No time, device/network diagnostic details, custom
text, or text style is included. This small alphanumeric payload is rendered
by the firmware as a 2× R11x27-M rMQR symbol, including quiet zone, in a
62×30 LED area.

The scanner retains support for the previous 37-byte diagnostic packet and
its 50-character Base64URL form.

## Development

```sh
npm install
npm run dev
```

Pushes to `main` deploy to GitHub Pages through the included workflow. Enable
**GitHub Actions** as the Pages source in the repository’s Pages settings once.
