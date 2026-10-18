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
import uuid

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


def payload_command(value, session, boot_id, previous_sequence, now_ms):
    """Bounded local capture protocol. No bus/actuator command or output pathname is accepted."""
    if (not isinstance(value, dict) or value.get("version") != 1 or value.get("kind") != "capture"
            or value.get("sessionId") != session or value.get("bootId") != boot_id):
        raise ValueError("Capture scope invalid")
    sequence = value.get("sequence")
    start, deadline = value.get("notBeforeMonotonicMs"), value.get("deadlineMonotonicMs")
    if (type(sequence) is not int or sequence <= previous_sequence or sequence > 0xFFFFFFFF
            or not all(type(v) in (int, float) and math.isfinite(v) for v in (start, deadline, now_ms))
            or start < 0 or start > now_ms + 5 or deadline <= now_ms or deadline - start > 2000):
        raise ValueError("Capture sequence/deadline invalid")
    return sequence, start, deadline


def payload_timestamp(metadata, boot_ns, mono_before_ns, mono_after_ns, not_before_ms):
    """Map libcamera first-row BOOTTIME to MONOTONIC; this is not sensor timing calibration."""
    sensor_ns, exposure_us = metadata.get("SensorTimestamp"), metadata.get("ExposureTime")
    if (type(sensor_ns) is not int or type(exposure_us) not in (int, float)
            or not math.isfinite(exposure_us) or not 0 <= exposure_us <= 1000000
            or mono_after_ns < mono_before_ns or not 0 <= boot_ns - sensor_ns <= 500000000):
        raise ValueError("Capture timestamp/exposure invalid")
    uncertainty_ms = (mono_after_ns - mono_before_ns) / 2000000
    if uncertainty_ms > 5:
        raise ValueError("Capture clock sampling uncertainty too large")
    captured_ms = (sensor_ns - boot_ns + (mono_before_ns + mono_after_ns) / 2) / 1000000
    # Reject pre-trigger exposure even when the completed frame was queued after the command.
    if captured_ms - exposure_us / 1000 - uncertainty_ms < not_before_ms:
        return None
    return captured_ms, uncertainty_ms, exposure_us


def payload_main(session):
    """Exclusive low-resolution still acquisition for the Pi AI Camera, without an inference model."""
    if not session or len(session) > 128 or not all(c.isascii() and (c.isalnum() or c in "_-") for c in session):
        raise ValueError("Invalid payload session")
    with contextlib.redirect_stdout(sys.stderr):
        import cv2
        from picamera2 import Picamera2
        cameras = [c for c in Picamera2.global_camera_info() if c.get("Model", "").lower() == "imx500"]
        if len(cameras) != 1:
            raise RuntimeError("Select exactly one connected IMX500; stop the tracking worker first")
        info = cameras[0]
        camera = Picamera2(info["Num"])
    boot_id, sequence, sync_sequence = uuid.uuid4().hex, 0, 0
    try:
        with contextlib.redirect_stdout(sys.stderr):
            camera.start(camera.create_preview_configuration(main={"size": (WIDTH, HEIGHT), "format": "RGB888"}, controls={"FrameRate": 15}, buffer_count=4), show_preview=False)
        hello = {"version": 1, "kind": "hello", "sessionId": session, "bootId": boot_id, "deviceId": str(info["Id"]), "model": "imx500", "evidence": "hardware", "width": WIDTH, "height": HEIGHT}
        print(json.dumps(hello, allow_nan=False), flush=True)
        while True:
            line = sys.stdin.buffer.readline(4097)
            if not line:
                break
            if len(line) > 4096 or not line.endswith(b"\n"):
                raise ValueError("Capture command exceeds packet budget")
            value = json.loads(line)
            if isinstance(value, dict) and value.get("kind") == "sync":
                seq = value.get("sequence")
                if (value.get("version") != 1 or value.get("sessionId") != session or value.get("bootId") != boot_id
                        or type(seq) is not int or not max(sequence, sync_sequence) < seq <= 0xFFFFFFFF):
                    raise ValueError("Invalid/replayed clock sync")
                sync_sequence = seq
                print(json.dumps({"version": 1, "kind": "sync", "sessionId": session, "bootId": boot_id,
                                  "sequence": seq, "monotonicMs": time.monotonic_ns() / 1000000}), flush=True)
                continue
            if not isinstance(value, dict) or value.get("sequence") != sync_sequence:
                raise ValueError("Capture requires fresh clock synchronization")
            sequence, start_ms, deadline_ms = payload_command(value, session, boot_id, sequence, time.monotonic_ns() / 1000000)
            while True:
                if time.monotonic_ns() / 1000000 >= deadline_ms:
                    raise TimeoutError("Capture deadline expired")
                request = camera.capture_request(wait=0.25)
                try:
                    metadata = request.get_metadata()
                    mono_before = time.monotonic_ns()
                    boot_ns = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
                    mono_after = time.monotonic_ns()
                    timing = payload_timestamp(metadata, boot_ns, mono_before, mono_after, start_ms)
                    if timing is None:
                        continue
                    with contextlib.redirect_stdout(sys.stderr):
                        ok, jpeg = cv2.imencode(".jpg", request.make_array("main"), [cv2.IMWRITE_JPEG_QUALITY, 85])
                    if not ok or len(jpeg) > 524288:
                        raise ValueError("Capture encoding failed or exceeded image budget")
                    acknowledged_ms = time.monotonic_ns() / 1000000
                    if acknowledged_ms >= deadline_ms:
                        raise TimeoutError("Capture encoding/ACK exceeded deadline")
                    packet = {"version": 1, "kind": "capture", "sessionId": session, "bootId": boot_id, "sequence": sequence, "capturedMonotonicMs": timing[0], "clockUncertaintyMs": timing[1], "exposureTimeUs": timing[2], "acknowledgedMonotonicMs": acknowledged_ms, "width": WIDTH, "height": HEIGHT, "jpeg": base64.b64encode(jpeg).decode("ascii")}
                    print(json.dumps(packet, allow_nan=False, separators=(",", ":")), flush=True)
                    break
                finally:
                    request.release()
    finally:
        with contextlib.redirect_stdout(sys.stderr):
            # Numeric capture_request timeouts leave a queued SDK job. Cancel it before stop.
            try:
                camera.cancel_all_and_flush()
            finally:
                try:
                    camera.stop()
                finally:
                    camera.close()


def main():
    # Do not leave a camera process holding the device after its Bun parent dies.
    parent = os.getppid()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent:
        raise RuntimeError("Unable to establish camera worker parent-death handling")
    if "--payload" in sys.argv:
        if "--session" not in sys.argv:
            raise ValueError("Payload session missing")
        def stop_payload(_signal, _frame):
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, stop_payload)
        signal.signal(signal.SIGINT, stop_payload)
        payload_main(sys.argv[sys.argv.index("--session") + 1])
        return
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
