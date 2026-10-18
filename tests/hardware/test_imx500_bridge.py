"""Vendor boundary tests without Pi packages or a camera. Not on-device validation."""
import importlib.util
import math
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


if __name__ == "__main__":
    unittest.main()
