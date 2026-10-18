"""Vendor boundary tests without Pi packages or a camera. Not on-device validation."""
import importlib.util
import math
import io
import json
import sys
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace
import unittest

path = Path(__file__).resolve().parents[2] / "resources/functions/drone/camera/imx500_worker.py"
spec = importlib.util.spec_from_file_location("imx500_worker", path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class Sensor:
    def __init__(self, rect=(128, 96, 256, 288)):
        self.rect = rect
        self.coords = None

    def get_input_size(self):
        return (320, 240)

    def convert_inference_coords(self, coords, metadata, camera):
        self.coords = coords
        return self.rect


def tensors(boxes=None, scores=None, classes=None):
    return [[boxes if boxes is not None else [[0.2, 0.2, 0.8, 0.6]]],
            [scores if scores is not None else [0.9]], [classes if classes is not None else [0]]]


class BridgeContract(unittest.TestCase):
    def test_only_confident_coco_person_is_emitted(self):
        result = bridge.person_detections(tensors(), None, Sensor(), {}, None)
        self.assertEqual(result[0]["label"], "person")
        self.assertEqual(result[0]["confidence"], 0.9)
        for key, value in {"x": 0.2, "y": 0.2, "width": 0.4, "height": 0.6}.items():
            self.assertAlmostEqual(result[0]["box"][key], value)
        self.assertEqual(bridge.person_detections(tensors(scores=[0.49]), None, Sensor(), {}, None), [])
        self.assertEqual(bridge.person_detections(tensors(classes=[1]), None, Sensor(), {}, None), [])

    def test_xy_pixel_boxes_are_normalized_and_reordered_for_sdk(self):
        sensor = Sensor()
        intrinsics = SimpleNamespace(bbox_normalization=True, bbox_order="xy")
        bridge.person_detections(tensors(boxes=[[32, 48, 160, 192]]), None, sensor, {}, intrinsics)
        self.assertEqual(sensor.coords, (0.2, 0.1, 0.8, 0.5))

    def test_mapped_rect_is_clipped_to_preview_and_empty_boxes_are_skipped(self):
        result = bridge.person_detections(tensors(), None, Sensor((-20, -10, 700, 510)), {}, None)
        self.assertEqual(result[0]["box"], {"x": 0, "y": 0, "width": 1, "height": 1})
        self.assertEqual(bridge.person_detections(tensors(), None, Sensor((5, 5, -1, 2)), {}, None), [])

    def test_bad_tensor_shapes_and_nonfinite_values_fail(self):
        for outputs in [[], tensors(scores=[]), tensors(scores=[math.nan]), tensors(boxes=[[0, 0, math.inf, 1]]), tensors(scores=[1.1])]:
            with self.subTest(outputs=outputs), self.assertRaises(ValueError):
                bridge.person_detections(outputs, None, Sensor(), {}, None)

    def test_detection_count_is_bounded(self):
        with self.assertRaises(ValueError):
            bridge.person_detections(tensors(boxes=[[0, 0, 1, 1]] * 33, scores=[0.9] * 33, classes=[0] * 33), None, Sensor(), {}, None)


class PayloadContract(unittest.TestCase):
    def command(self, **changes):
        value = {"version": 1, "kind": "capture", "sessionId": "session", "bootId": "boot", "sequence": 1,
                 "notBeforeMonotonicMs": 1000, "deadlineMonotonicMs": 2000}
        return {**value, **changes}

    def test_bounded_scoped_commands_and_no_replayed_sequence(self):
        self.assertEqual(bridge.payload_command(self.command(), "session", "boot", 0, 1000), (1, 1000, 2000))
        for changes in [{"sequence": True}, {"sequence": 0}, {"sequence": 2**32}, {"sessionId": "other"},
                        {"bootId": "other"}, {"notBeforeMonotonicMs": math.nan}, {"deadlineMonotonicMs": 999},
                        {"deadlineMonotonicMs": 4000}, {"notBeforeMonotonicMs": 1010}, {"version": 2}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                bridge.payload_command(self.command(**changes), "session", "boot", 0, 1000)
        with self.assertRaises(ValueError):
            bridge.payload_command(self.command(), "session", "boot", 1, 1000)

    def test_boot_clock_offset_and_pretrigger_exposure_rejection(self):
        # BOOTTIME includes suspend, MONOTONIC does not. Synthetic offset is 10 seconds.
        meta = {"SensorTimestamp": 11020000000, "ExposureTime": 1000}
        timing = bridge.payload_timestamp(meta, 11040000000, 1040000000, 1042000000, 1000)
        self.assertEqual(timing, (1021.0, 1.0, 1000))
        self.assertIsNone(bridge.payload_timestamp(meta, 11040000000, 1040000000, 1042000000, 1020))

    def test_timestamp_missing_stale_future_or_uncertain_fails(self):
        meta = {"SensorTimestamp": 1020000000, "ExposureTime": 1000}
        for bad in [{}, {**meta, "SensorTimestamp": True}, {**meta, "SensorTimestamp": 1041000000},
                    {**meta, "SensorTimestamp": 1}, {**meta, "ExposureTime": math.inf}, {**meta, "ExposureTime": -1}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                bridge.payload_timestamp(bad, 1040000000, 1040000000, 1040000000, 1000)
        with self.assertRaises(ValueError):
            bridge.payload_timestamp(meta, 1040000000, 1040000000, 1060000000, 1000)
        with self.assertRaises(ValueError):
            bridge.payload_timestamp(meta, 1040000000, 1040000000, 1030000000, 1000)


class PayloadSdkBoundary(unittest.TestCase):
    def run_worker(self, broken_metadata=False, no_camera=False, timeout=False, encoding_failure=False):
        class Request:
            released = False
            def get_metadata(self):
                return {} if broken_metadata else {"SensorTimestamp": 11030000000, "ExposureTime": 1000}
            def make_array(self, stream):
                self.stream = stream
                return "pixels"
            def release(self):
                self.released = True

        class Camera:
            stopped = closed = pending = False
            events = None
            def create_preview_configuration(self, **kwargs):
                return kwargs
            def start(self, config, **kwargs):
                self.config = config
            def capture_request(self, **kwargs):
                self.wait = kwargs["wait"]
                if timeout:
                    self.pending = True
                    raise TimeoutError("SDK request timed out")
                return request
            def cancel_all_and_flush(self):
                self.pending = False
                self.events = ["cancel"]
            def stop(self):
                if self.pending:
                    raise AssertionError("Stop queued behind an incomplete capture")
                self.events.append("stop")
                self.stopped = True
            def close(self):
                self.events.append("close")
                self.closed = True

        request, camera = Request(), Camera()
        class Pi:
            def __new__(cls, number):
                return camera
            @staticmethod
            def global_camera_info():
                return [] if no_camera else [{"Model": "imx500", "Id": "fixture-device", "Num": 0}]

        command = {"version": 1, "kind": "capture", "sessionId": "session", "bootId": "boot", "sequence": 1,
                   "notBeforeMonotonicMs": 1000, "deadlineMonotonicMs": 2000}
        sync = {**command, "kind": "sync"}
        source = io.TextIOWrapper(io.BytesIO((json.dumps(sync) + "\n" + json.dumps(command) + "\n").encode()))
        output = io.StringIO()
        with patch.dict(sys.modules, {"cv2": SimpleNamespace(IMWRITE_JPEG_QUALITY=1, imencode=lambda *args: (not encoding_failure, b"fixture-jpeg")), "picamera2": SimpleNamespace(Picamera2=Pi)}), \
                patch.object(bridge.sys, "stdin", source), patch.object(bridge.sys, "stdout", output), \
                patch.object(bridge.uuid, "uuid4", return_value=SimpleNamespace(hex="boot")), \
                patch.object(bridge.time, "monotonic_ns", return_value=1040000000), \
                patch.object(bridge.time, "clock_gettime_ns", return_value=11040000000), \
                patch.object(bridge.time, "CLOCK_BOOTTIME", 7, create=True):
            if timeout:
                with self.assertRaises(TimeoutError):
                    bridge.payload_main("session")
            elif broken_metadata or encoding_failure:
                with self.assertRaises(ValueError):
                    bridge.payload_main("session")
            elif no_camera:
                with self.assertRaises(RuntimeError):
                    bridge.payload_main("session")
            else:
                bridge.payload_main("session")
        return request, camera, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_still_acquisition_publishes_identity_and_releases_request(self):
        request, camera, packets = self.run_worker()
        self.assertTrue(request.released and camera.stopped and camera.closed)
        self.assertEqual(camera.wait, 0.25)
        self.assertEqual(packets[0]["model"], "imx500")
        self.assertEqual(packets[2]["capturedMonotonicMs"], 1030)
        self.assertEqual(packets[2]["sequence"], 1)
        self.assertLess(packets[2]["capturedMonotonicMs"], packets[2]["acknowledgedMonotonicMs"])

    def test_invalid_metadata_releases_request_and_closes_device(self):
        request, camera, packets = self.run_worker(broken_metadata=True)
        self.assertTrue(request.released and camera.stopped and camera.closed)
        self.assertEqual(len(packets), 2)  # Handshake and sync only; never a fabricated capture ACK.

    def test_timeout_cancels_pending_sdk_job_before_stop_and_close(self):
        request, camera, packets = self.run_worker(timeout=True)
        self.assertFalse(request.released)  # SDK returned no request to release.
        self.assertTrue(camera.stopped and camera.closed)
        self.assertEqual(camera.events, ["cancel", "stop", "close"])
        self.assertEqual(len(packets), 2)

    def test_encoding_failure_releases_request_without_a_capture_ack(self):
        request, camera, packets = self.run_worker(encoding_failure=True)
        self.assertTrue(request.released and camera.stopped and camera.closed)
        self.assertEqual(len(packets), 2)

    def test_no_imx500_fails_before_capture(self):
        request, camera, packets = self.run_worker(no_camera=True)
        self.assertFalse(request.released)
        self.assertEqual(packets, [])


if __name__ == "__main__":
    unittest.main()
