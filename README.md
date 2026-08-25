# rMQR Binary Scanner

A browser-only rMQR scanner tailored for the device diagnostic code. It
uses ZXing-C++ WebAssembly to scan only `RMQRCode` symbols and displays the
decoder's raw `bytes` buffer, hex, Base64URL, decoded text, and device v1
diagnostic fields.

## device format

Current device firmware emits an unpadded 50-character Base64URL string.
Decode it to recover the 37-byte binary packet. The scanner recognizes either
that text representation or a direct 37-byte packet and validates the
CRC-16/CCITT-FALSE checksum.

## Development

```sh
npm install
npm run dev
```

Pushes to `main` deploy to GitHub Pages through the included workflow. Enable
**GitHub Actions** as the Pages source in the repository’s Pages settings once.
