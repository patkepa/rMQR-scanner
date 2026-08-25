import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import "./style.css";

const camera = document.querySelector("#camera");
const imageInput = document.querySelector("#image-input");
const startCameraButton = document.querySelector("#start-camera");
const cameraStatus = document.querySelector("#camera-status");
const resultStatus = document.querySelector("#result-status");
const packetStatus = document.querySelector("#packet-status");
const cameraEmpty = document.querySelector("#camera-empty");
const resultEmpty = document.querySelector("#result-empty");
const resultContent = document.querySelector("#result-content");
const textOutput = document.querySelector("#text-output");
const hexOutput = document.querySelector("#hex-output");
const base64Output = document.querySelector("#base64-output");
const decodedFields = document.querySelector("#decoded-fields");

const scanCanvas = document.createElement("canvas");
const scanContext = scanCanvas.getContext("2d", { willReadFrequently: true });
const recoverySourceCanvas = document.createElement("canvas");
const recoverySourceContext = recoverySourceCanvas.getContext("2d", { willReadFrequently: true });
const recoveryCanvas = document.createElement("canvas");
const recoveryContext = recoveryCanvas.getContext("2d", { willReadFrequently: true });
const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();
const TEMPORAL_FRAME_COUNT = 8;
const LED_FRAME_INTERVAL_MS = 75;
const readerOptions = {
  formats: ["RMQRCode"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDenoise: true,
  maxNumberOfSymbols: 1,
  binarizer: "LocalAverage",
};
const ledReaderOptions = [
  { ...readerOptions, tryDenoise: false, binarizer: "LocalAverage" },
  { ...readerOptions, tryDenoise: false, binarizer: "GlobalHistogram" },
  { ...readerOptions, tryDenoise: true, binarizer: "LocalAverage" },
];

let stream;
let scanning = false;
let scanBusy = false;
let scanTimer;
let lastPayload = "";
let temporalPixels;
let temporalWidth = 0;
let temporalHeight = 0;
let temporalFrameCount = 0;

function setStatus(element, text, tone = "idle") {
  element.textContent = text;
  element.className = `status ${tone}`;
}

function setCameraStatus(text, tone) {
  setStatus(cameraStatus, text, tone);
}

function base64Url(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0").toUpperCase())
    .reduce((lines, value, index) => {
      const line = Math.floor(index / 12);
      lines[line] ??= [];
      lines[line].push(value);
      return lines;
    }, [])
    .map((line) => line.join(" "))
    .join("\n");
}

function visibleText(text, bytes) {
  if (/^[\x20-\x7E\r\n\t]*$/.test(text)) return text || "(empty text payload)";
  return `[Binary payload: ${bytes.length} bytes — see hexadecimal and Base64URL]`;
}

function crc16CcittFalse(bytes) {
  let crc = 0xffff;
  for (const value of bytes) {
    crc ^= value << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeBase45DisplayFlags(value) {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  if (value.length !== 6) return null;
  const bytes = new Uint8Array(4);
  for (let pair = 0; pair < 2; pair += 1) {
    const offset = pair * 3;
    const first = alphabet.indexOf(value[offset]);
    const second = alphabet.indexOf(value[offset + 1]);
    const third = alphabet.indexOf(value[offset + 2]);
    if (first < 0 || second < 0 || third < 0) return null;
    const decoded = first + second * 45 + third * 45 * 45;
    if (decoded > 0xffff) return null;
    bytes[pair * 2] = decoded & 0xff;
    bytes[pair * 2 + 1] = decoded >>> 8;
  }
  return bytes;
}

function readLe24(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readLe32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function displayPacket(bytes) {
  const maybeText = textDecoder.decode(bytes);
  const displayFlags = decodeBase45DisplayFlags(maybeText);
  if (displayFlags) {
    const state = readLe32(displayFlags, 0);
    return {
      statusText: "Display flags decoded",
      statusTone: "success",
      fields: [
        ["Payload format", "High-reliability display flags · Base45"],
        ["Encoded payload", maybeText],
        ["Packed state bytes", hex(displayFlags).replaceAll("\n", " ")],
        ["State flags", `0x${state.toString(16).padStart(8, "0").toUpperCase()}`],
        ["Main state", state & 0x0f],
        ["Secondary states", `0x${((state >>> 4) & 0x1ff).toString(16).toUpperCase()}`],
        ["Display-image flags", `0x${((state >>> 13) & 0x7ff).toString(16).toUpperCase()}`],
        ["Previous screen", (state >>> 24) & 0x0f],
        ["Wi-Fi / cloud / custom text", `${(state & (1 << 28)) !== 0 ? "connected" : "off"} / ${(state & (1 << 29)) !== 0 ? "connected" : "off"} / ${(state & (1 << 30)) !== 0 ? "enabled" : "off"}`],
        ["Excluded by design", "Time, device and network details, custom text and style"],
      ],
    };
  }

  const raw = bytes.length === 37 ? bytes : decodeBase64Url(maybeText);
  if (!raw || raw.length !== 37 || raw[0] !== 1 || raw[1] > 16) return null;

  const expectedCrc = raw[35] | (raw[36] << 8);
  const actualCrc = crc16CcittFalse(raw.subarray(0, 35));
  const state = readLe32(raw, 18);
  const firmware = Array.from(raw.subarray(32, 35), (part) => part === 255 ? "unavailable" : part === 254 ? "overflow" : String(part)).join(".");
  const rssi = raw[26] > 127 ? raw[26] - 256 : raw[26];
  return {
    statusText: actualCrc === expectedCrc ? "Legacy CRC valid" : "Legacy CRC invalid",
    statusTone: actualCrc === expectedCrc ? "success" : "error",
    fields: [
      ["Format version", raw[0]],
      ["Device name", textDecoder.decode(raw.subarray(2, 2 + raw[1])) || "—"],
      ["State flags", `0x${state.toString(16).padStart(8, "0").toUpperCase()}`],
      ["Main state", state & 0x0f],
      ["Secondary states", `0x${((state >>> 4) & 0x1ff).toString(16).toUpperCase()}`],
      ["Display-image flags", `0x${((state >>> 13) & 0x7ff).toString(16).toUpperCase()}`],
      ["Previous screen", (state >>> 24) & 0x0f],
      ["Wi-Fi / cloud / custom text", `${(state & (1 << 28)) !== 0 ? "connected" : "off"} / ${(state & (1 << 29)) !== 0 ? "connected" : "off"} / ${(state & (1 << 30)) !== 0 ? "enabled" : "off"}`],
      ["IPv4 address", Array.from(raw.subarray(22, 26)).join(".")],
      ["Wi-Fi RSSI", rssi === -128 ? "unavailable" : `${rssi} dBm`],
      ["Uptime", `${readLe24(raw, 27).toLocaleString()} minutes`],
      ["Free heap", `${(raw[30] | (raw[31] << 8)).toLocaleString()} KiB`],
      ["Firmware", firmware],
      ["CRC-16 / CCITT-FALSE", `0x${expectedCrc.toString(16).padStart(4, "0").toUpperCase()} · ${actualCrc === expectedCrc ? "valid" : "invalid"}`],
    ],
  };
}

function showPacket(bytes) {
  const packet = displayPacket(bytes);
  decodedFields.replaceChildren();
  if (!packet) {
    setStatus(packetStatus, "Not a device packet", "idle");
    const detail = document.createElement("p");
    detail.className = "packet-note";
    detail.textContent = "The raw bytes are preserved above. device parsing expects the six-character Base45 display-flags payload; legacy 37-byte and 50-character Base64URL packets are also supported.";
    decodedFields.append(detail);
    return;
  }
  setStatus(packetStatus, packet.statusText, packet.statusTone);
  for (const [label, value] of packet.fields) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    decodedFields.append(term, description);
  }
}

function showResult(result) {
  const bytes = result.bytes instanceof Uint8Array ? result.bytes : textEncoder.encode(result.text ?? "");
  const payloadKey = base64Url(bytes);
  if (payloadKey === lastPayload) return;
  lastPayload = payloadKey;
  textOutput.textContent = visibleText(result.text ?? textDecoder.decode(bytes), bytes);
  hexOutput.textContent = hex(bytes);
  base64Output.textContent = payloadKey;
  showPacket(bytes);
  resultEmpty.hidden = true;
  resultContent.hidden = false;
  setStatus(resultStatus, `${result.format} · ${bytes.length} bytes`, "success");
  setCameraStatus("rMQR decoded", "success");
  navigator.vibrate?.(35);
}

async function decodeInput(input, options = readerOptions) {
  const results = await readBarcodes(input, options);
  if (results.length > 0) showResult(results[0]);
  return results.length > 0;
}

function downsampleLedFrame(frame, scale) {
  recoverySourceCanvas.width = frame.width;
  recoverySourceCanvas.height = frame.height;
  recoverySourceContext.putImageData(frame, 0, 0);
  recoveryCanvas.width = Math.max(1, Math.round(frame.width * scale));
  recoveryCanvas.height = Math.max(1, Math.round(frame.height * scale));
  recoveryContext.imageSmoothingEnabled = true;
  recoveryContext.imageSmoothingQuality = "high";
  recoveryContext.drawImage(recoverySourceCanvas,
                            0,
                            0,
                            recoveryCanvas.width,
                            recoveryCanvas.height);
  return recoveryContext.getImageData(0,
                                      0,
                                      recoveryCanvas.width,
                                      recoveryCanvas.height);
}

async function decodeLedFrame(frame) {
  const candidates = [frame, downsampleLedFrame(frame, 0.7)];
  for (const candidate of candidates) {
    for (const options of ledReaderOptions) {
      if (await decodeInput(candidate, options)) return true;
    }
  }
  return false;
}

function resetTemporalFrame() {
  temporalPixels = undefined;
  temporalWidth = 0;
  temporalHeight = 0;
  temporalFrameCount = 0;
}

function addTemporalFrame(frame) {
  if ((temporalPixels === undefined) ||
     (temporalWidth !== frame.width) || (temporalHeight !== frame.height)) {
    temporalPixels = new Uint8ClampedArray(frame.data);
    temporalWidth = frame.width;
    temporalHeight = frame.height;
    temporalFrameCount = 1;
    return null;
  }

  for (let index = 0; index < temporalPixels.length; index += 4) {
    temporalPixels[index] = Math.max(temporalPixels[index], frame.data[index]);
    temporalPixels[index + 1] = Math.max(temporalPixels[index + 1], frame.data[index + 1]);
    temporalPixels[index + 2] = Math.max(temporalPixels[index + 2], frame.data[index + 2]);
    temporalPixels[index + 3] = 255;
  }
  temporalFrameCount += 1;
  if (temporalFrameCount < TEMPORAL_FRAME_COUNT) return null;

  const combined = new ImageData(new Uint8ClampedArray(temporalPixels),
                                 temporalWidth,
                                 temporalHeight);
  resetTemporalFrame();
  return combined;
}

function cameraFrame() {
  if (!scanning || scanBusy || camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const sourceWidth = camera.videoWidth;
  const sourceHeight = camera.videoHeight;
  if (!sourceWidth || !sourceHeight) return;
  scanBusy = true;
  const scale = Math.min(1, 960 / Math.max(sourceWidth, sourceHeight));
  scanCanvas.width = Math.max(1, Math.floor(sourceWidth * scale));
  scanCanvas.height = Math.max(1, Math.floor(sourceHeight * scale));
  scanContext.drawImage(camera, 0, 0, scanCanvas.width, scanCanvas.height);
  const combinedFrame = addTemporalFrame(
    scanContext.getImageData(0, 0, scanCanvas.width, scanCanvas.height));
  if (combinedFrame === null) {
    setCameraStatus(`Averaging LED frames (${temporalFrameCount}/${TEMPORAL_FRAME_COUNT})`, "active");
    scanBusy = false;
    return;
  }
  decodeLedFrame(combinedFrame)
    .catch(() => undefined)
    .finally(() => { scanBusy = false; });
}

function startScanLoop() {
  window.clearInterval(scanTimer);
  scanTimer = window.setInterval(cameraFrame, LED_FRAME_INTERVAL_MS);
}

async function startCamera() {
  if (stream) {
    stopCamera();
    return;
  }
  startCameraButton.disabled = true;
  setCameraStatus("Preparing decoder…", "idle");
  try {
    await prepareZXingModule({ fireImmediately: true });
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60, min: 30 },
      },
      audio: false,
    });
    camera.srcObject = stream;
    await camera.play();
    scanning = true;
    resetTemporalFrame();
    cameraEmpty.hidden = true;
    startCameraButton.innerHTML = "<span aria-hidden=\"true\">■</span> Stop camera";
    setCameraStatus("Scanning rMQR", "active");
    startScanLoop();
  } catch (error) {
    setCameraStatus("Camera unavailable", "error");
    resultEmpty.hidden = false;
    resultEmpty.querySelector("p").textContent = error.name === "NotAllowedError" ? "Camera access was denied. You can still upload an image." : "The camera could not be started. You can still upload an image.";
  } finally {
    startCameraButton.disabled = false;
  }
}

function stopCamera() {
  scanning = false;
  resetTemporalFrame();
  window.clearInterval(scanTimer);
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  camera.srcObject = null;
  cameraEmpty.hidden = false;
  startCameraButton.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 7h3l1.2-2h9.6L17 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm9 3a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z\"/></svg>Start camera";
  setCameraStatus("Camera off", "idle");
}

async function decodeFile(file) {
  if (!file) return;
  setStatus(resultStatus, "Reading image…", "idle");
  try {
    await prepareZXingModule({ fireImmediately: true });
    if (!(await decodeInput(file))) setStatus(resultStatus, "No rMQR found", "error");
  } catch {
    setStatus(resultStatus, "Could not read image", "error");
  }
}

startCameraButton.addEventListener("click", startCamera);
imageInput.addEventListener("change", (event) => decodeFile(event.target.files?.[0]));
document.querySelectorAll(".copy-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const output = document.querySelector(`#${button.dataset.copy}`);
    await navigator.clipboard.writeText(output.textContent);
    const label = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = label; }, 1400);
  });
});

window.addEventListener("beforeunload", stopCamera);
