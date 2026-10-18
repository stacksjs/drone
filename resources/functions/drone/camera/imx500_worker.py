"""Picamera2 hardware bridge only. All association and selection policy is TypeScript."""
import base64
import contextlib
import ctypes
import json
import math
import os
import signal
import sys
import time

MODEL = "/usr/share/imx500-models/imx500_network_ssd_mobilenetv2_fpnlite_320x320_pp.rpk"
WIDTH, HEIGHT = 640, 480


def person_detections(outputs, camera, imx500, metadata, intrinsics):
    """The bundled SSD postprocessed model emits boxes, scores and COCO class indices."""
    if len(outputs) < 3:
        raise ValueError("Expected postprocessed SSD boxes, scores and classes")
    boxes, scores, classes = outputs[0][0], outputs[1][0], outputs[2][0]
    if not (len(boxes) == len(scores) == len(classes)):
        raise ValueError("Detection tensor lengths disagree")
    result = []
    for box, score, category in zip(boxes, scores, classes):
        score, category = float(score), float(category)
        if not math.isfinite(score) or not math.isfinite(category):
            raise ValueError("Non-finite inference")
        if category != 0 or score < 0.5:
            continue
        coords = [float(value) for value in box]
        if len(coords) != 4 or not all(math.isfinite(value) for value in coords) or score > 1:
            raise ValueError("Invalid detection")
        if intrinsics and intrinsics.bbox_normalization:
            input_width, input_height = imx500.get_input_size()
            divisor = [input_width, input_height, input_width, input_height] if intrinsics.bbox_order == "xy" else [input_height, input_width, input_height, input_width]
            coords = [value / scale for value, scale in zip(coords, divisor)]
        if intrinsics and intrinsics.bbox_order == "xy":
            coords = [coords[1], coords[0], coords[3], coords[2]]
        rect = imx500.convert_inference_coords(tuple(coords), metadata, camera)
        if hasattr(rect, "x"):
            rect = (rect.x, rect.y, rect.width, rect.height)
        x, y, width, height = [float(value) for value in rect]
        if not all(math.isfinite(value) for value in (x, y, width, height)):
            raise ValueError("Invalid mapped detection")
        x0, y0 = max(0, min(1, x / WIDTH)), max(0, min(1, y / HEIGHT))
        x1, y1 = max(0, min(1, (x + width) / WIDTH)), max(0, min(1, (y + height) / HEIGHT))
        if x1 > x0 and y1 > y0:
            result.append({"label": "person", "confidence": score, "box": {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}})
    if len(result) > 32:
        raise ValueError("Too many detections for bounded tracking")
    return result


def main():
    # Do not leave a camera process holding the device after its Bun parent dies.
    parent = os.getppid()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent:
        raise RuntimeError("Unable to establish camera worker parent-death handling")
    # Vendor diagnostics must not contaminate the bounded NDJSON protocol on stdout.
    with contextlib.redirect_stdout(sys.stderr):
        import cv2
        from picamera2 import Picamera2
        from picamera2.devices import IMX500
        from picamera2.devices.imx500.imx500 import CnnOutputTensorInfoExported
        imx500 = IMX500(MODEL)
        intrinsics = imx500.network_intrinsics
        if intrinsics and (intrinsics.task not in (None, "object detection") or intrinsics.postprocess not in (None, "")):
            raise ValueError("Unsupported network output contract; use the documented SSD model")
        camera = Picamera2(imx500.camera_num)
        config = camera.create_preview_configuration(main={"size": (WIDTH, HEIGHT), "format": "RGB888"}, controls={"FrameRate": 15}, buffer_count=4)
        camera.start(config, show_preview=False)
        imx500.set_inference_aspect_ratio(imx500.get_input_size())
    running = True

    def stop(_signal, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    last_counter, sequence = None, 0
    try:
        while running:
            request = camera.capture_request()
            try:
                metadata = request.get_metadata()
                sensor_timestamp = metadata.get("SensorTimestamp")
                if not isinstance(sensor_timestamp, int):
                    raise ValueError("Sensor timestamp unavailable")
                age_ns = time.clock_gettime_ns(time.CLOCK_BOOTTIME) - sensor_timestamp
                if age_ns < 0 or age_ns > 500_000_000:
                    continue
                captured_ms = (time.monotonic_ns() - age_ns) / 1_000_000
                raw_info = metadata.get("CnnOutputTensorInfo")
                if not raw_info:
                    continue
                raw_info = bytes(raw_info)
                if len(raw_info) != ctypes.sizeof(CnnOutputTensorInfoExported):
                    raise ValueError("Unsupported inference metadata ABI; update Picamera2 and this bridge together")
                info = CnnOutputTensorInfoExported.from_buffer_copy(raw_info)
                counter = info.frameCount
                if counter == last_counter:
                    continue  # Never refresh a target using repeated inference metadata.
                with contextlib.redirect_stdout(sys.stderr):
                    outputs = imx500.get_outputs(metadata, add_batch=True)
                    if outputs is None:
                        continue
                    detections = person_detections(outputs, camera, imx500, metadata, intrinsics)
                    ok, jpeg = cv2.imencode(".jpg", request.make_array("main"), [cv2.IMWRITE_JPEG_QUALITY, 65])
                if not ok:
                    raise ValueError("Preview encoding failed")
                last_counter = counter
                sequence += 1
                packet = {"version": 1, "sequence": sequence, "capturedMonotonicMs": captured_ms, "detections": detections, "jpeg": base64.b64encode(jpeg).decode("ascii")}
                print(json.dumps(packet, allow_nan=False, separators=(",", ":")), flush=True)
            finally:
                request.release()
    finally:
        camera.stop()
        camera.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"IMX500 bridge: {error}", file=sys.stderr)
        sys.exit(1)
