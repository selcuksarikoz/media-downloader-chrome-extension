export let autoPipBridgeEnabled = false;
export let autoPipBridgeVideoId = "";
export let autoPipPageHandler = null;

export function setAutoPipBridgeEnabled(value) {
  autoPipBridgeEnabled = value;
}

export function setAutoPipBridgeVideoId(value) {
  autoPipBridgeVideoId = value;
}

export function setAutoPipPageHandler(handler) {
  autoPipPageHandler = handler;
}
