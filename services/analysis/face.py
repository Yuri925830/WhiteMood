from __future__ import annotations

import io
import os
import threading
from functools import lru_cache
from typing import Any

import numpy as np

from .errors import ComponentUnavailable

MAX_IMAGE_PIXELS = 2_100_000
_model_lock = threading.Lock()


@lru_cache(maxsize=1)
def _runtime() -> tuple[Any, Any, Any]:
    try:
        import cv2
        from emotiefflib.facial_analysis import EmotiEffLibRecognizer
    except ImportError as exc:
        raise ComponentUnavailable("EmotiEffLib dependencies are not installed") from exc
    detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if detector.empty():
        raise ComponentUnavailable("OpenCV face detector is unavailable")
    try:
        recognizer = EmotiEffLibRecognizer(
            engine=os.getenv("WHITEMOOD_FACE_ENGINE", "torch"),
            model_name=os.getenv("WHITEMOOD_FACE_MODEL", "enet_b0_8_best_afew"),
            device=os.getenv("WHITEMOOD_FACE_DEVICE", "cuda"),
        )
    except (OSError, RuntimeError, ValueError, ImportError) as exc:
        raise ComponentUnavailable("EmotiEffLib model is unavailable") from exc
    return cv2, detector, recognizer


def _decode_image(data: bytes) -> np.ndarray:
    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError as exc:
        raise ComponentUnavailable("Pillow is not installed") from exc
    try:
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            if width < 40 or height < 40 or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("image dimensions are outside the supported range")
            return np.asarray(image.convert("RGB"))
    except (OSError, UnidentifiedImageError) as exc:
        raise ValueError("invalid image") from exc


def _largest_face(cv2: Any, detector: Any, image: np.ndarray) -> tuple[np.ndarray, float] | None:
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    boxes = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
    if len(boxes) == 0:
        return None
    x, y, width, height = max(boxes, key=lambda box: int(box[2]) * int(box[3]))
    padding = round(max(width, height) * 0.08)
    x1, y1 = max(0, x - padding), max(0, y - padding)
    x2, y2 = min(image.shape[1], x + width + padding), min(image.shape[0], y + height + padding)
    area_ratio = width * height / max(1, image.shape[0] * image.shape[1])
    return image[y1:y2, x1:x2], float(area_ratio)


def aggregate_expression_scores(
    scores: np.ndarray,
    labels: dict[int, str],
    detected_frames: int,
    total_frames: int,
    area_ratios: list[float],
) -> dict[str, Any]:
    if scores.ndim != 2 or scores.shape[0] != detected_frames or scores.shape[1] != len(labels):
        raise ValueError("invalid expression score shape")
    means = np.mean(scores, axis=0)
    features = {
        f"expression_{labels[index].lower()}": round(float(means[index]), 6)
        for index in range(len(labels))
    }
    detection_ratio = detected_frames / max(1, total_frames)
    scale_quality = min(1.0, float(np.mean(np.sqrt(area_ratios))) / 0.45)
    quality = max(0.0, min(1.0, 0.75 * detection_ratio + 0.25 * scale_quality))
    return {
        "quality": round(quality, 4),
        "confidence": round(float(np.max(means)), 4),
        "features": features,
        "framesAnalyzed": detected_frames,
        "framesReceived": total_frames,
    }


def analyze_faces(images: list[bytes]) -> dict[str, Any] | None:
    cv2, detector, recognizer = _runtime()
    faces: list[np.ndarray] = []
    area_ratios: list[float] = []
    for data in images:
        detected = _largest_face(cv2, detector, _decode_image(data))
        if detected:
            face, area_ratio = detected
            faces.append(face)
            area_ratios.append(area_ratio)
    if not faces:
        return None
    with _model_lock:
        _, scores = recognizer.predict_emotions(faces, logits=False)
    labels = dict(recognizer.idx_to_emotion_class)
    return aggregate_expression_scores(np.asarray(scores), labels, len(faces), len(images), area_ratios)
