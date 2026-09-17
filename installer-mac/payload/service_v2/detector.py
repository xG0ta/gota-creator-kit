import math
from pathlib import Path

import cv2
import numpy as np

from .tracking import FaceObservation, IdentityTracker, choose_speaker


class YuNetDetector:
    def __init__(
        self,
        model_path: Path,
        score_threshold: float = 0.78,
        require_classic_confirmation: bool = True,
    ):
        if not model_path.is_file():
            raise FileNotFoundError(f"Falta el modelo YuNet: {model_path}")
        self.detector = cv2.FaceDetectorYN.create(
            str(model_path), "", (320, 320), score_threshold, 0.3, 5000
        )
        self.require_classic_confirmation = require_classic_confirmation
        cascade_root = Path(cv2.data.haarcascades)
        self.frontal = cv2.CascadeClassifier(
            str(cascade_root / "haarcascade_frontalface_default.xml")
        )
        self.profile = cv2.CascadeClassifier(
            str(cascade_root / "haarcascade_profileface.xml")
        )

    @staticmethod
    def _classic_confirms(face, classic_boxes):
        x, y, w, h = face
        center_x, center_y = x + w / 2, y + h / 2
        for cx, cy, cw, ch in classic_boxes:
            padding_x, padding_y = cw * 0.35, ch * 0.35
            if (
                cx - padding_x <= center_x <= cx + cw + padding_x
                and cy - padding_y <= center_y <= cy + ch + padding_y
            ):
                return True
        return False

    def detect(self, frame: np.ndarray, time_seconds: float):
        height, width = frame.shape[:2]
        self.detector.setInputSize((width, height))
        _, results = self.detector.detect(frame)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        classic_boxes = list(self.frontal.detectMultiScale(
            gray, scaleFactor=1.12, minNeighbors=5, minSize=(28, 28)
        ))
        classic_boxes += list(self.profile.detectMultiScale(
            gray, scaleFactor=1.12, minNeighbors=5, minSize=(28, 28)
        ))
        flipped = cv2.flip(gray, 1)
        for x, y, w, h in self.profile.detectMultiScale(
            flipped, scaleFactor=1.12, minNeighbors=5, minSize=(28, 28)
        ):
            classic_boxes.append((width - x - w, y, w, h))
        output = []
        for row in results if results is not None else []:
            x, y, w, h = row[:4]
            area_ratio = float(w * h) / max(1, width * height)
            confirmed = self._classic_confirms((x, y, w, h), classic_boxes)
            if area_ratio < 0.0025 or area_ratio > 0.32:
                continue
            if (
                self.require_classic_confirmation
                and not confirmed
                and float(row[-1]) < 0.91
            ):
                continue
            output.append(FaceObservation(
                time=time_seconds,
                x=max(0.0, float(x) / width),
                y=max(0.0, float(y) / height),
                width=min(1.0, float(w) / width),
                height=min(1.0, float(h) / height),
                confidence=float(row[-1]),
            ))
        return output


def analyze_identities(
    video_path: Path,
    model_path: Path,
    sample_fps: float = 4.0,
    max_width: int = 640,
    start_seconds: float = 0.0,
    end_seconds: float | None = None,
    progress_callback=None,
    sensitivity: str = "balanced",
):
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("No se pudo abrir el video")
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    video_duration = frame_count / fps if fps else 0.0
    range_end = min(video_duration, end_seconds or video_duration)
    start_frame = max(0, round(start_seconds * fps))
    end_frame = min(frame_count, round(range_end * fps))
    thresholds = {
        "strict": (0.84, True),
        "balanced": (0.78, True),
        "permissive": (0.72, False),
    }
    score_threshold, require_confirmation = thresholds.get(
        sensitivity, thresholds["balanced"]
    )
    detector = YuNetDetector(
        model_path, score_threshold, require_confirmation
    )
    tracker = IdentityTracker()
    step = max(1, round(fps / sample_fps))
    frames = []
    previous_patches: dict[str, np.ndarray] = {}
    previous_speaker = None

    # No construimos una lista con todos los fotogramas ni hacemos una búsqueda
    # aleatoria por cada muestra. En clips largos ambas cosas podían volver la
    # tarea frágil. Abrimos el vídeo una vez y lo recorremos por saltos, sin un
    # límite de duración ni de número de muestras.
    total_samples = max(1, math.ceil(max(0, end_frame - start_frame) / step))
    capture.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    frame_number = start_frame
    sample_index = 0
    while frame_number < end_frame:
        ok, frame = capture.read()
        if not ok:
            break
        time_seconds = frame_number / fps
        height, width = frame.shape[:2]
        scale = min(1.0, max_width / width)
        small = cv2.resize(
            frame, (round(width * scale), round(height * scale)),
            interpolation=cv2.INTER_AREA
        )
        observations = tracker.assign(detector.detect(small, time_seconds))
        for item in observations:
            sh, sw = small.shape[:2]
            x1 = max(0, round(item.x * sw))
            x2 = min(sw, round((item.x + item.width) * sw))
            y1 = max(0, round((item.y + item.height * 0.52) * sh))
            y2 = min(sh, round((item.y + item.height) * sh))
            roi = small[y1:y2, x1:x2]
            if roi.size:
                gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
                patch = cv2.resize(gray, (48, 24), interpolation=cv2.INTER_AREA)
                old = previous_patches.get(item.subject_id)
                if old is not None:
                    item.mouth_activity = float(
                        np.mean(cv2.absdiff(patch, old)) / 255.0
                    )
                previous_patches[item.subject_id] = patch
        previous_speaker = choose_speaker(observations, previous_speaker)
        frames.append({
            "timeSeconds": round(time_seconds, 4),
            "speakerId": previous_speaker,
            "subjects": [
                {
                    "id": item.subject_id,
                    "x": round(item.x, 6),
                    "y": round(item.y, 6),
                    "width": round(item.width, 6),
                    "height": round(item.height, 6),
                    "confidence": round(item.confidence, 4),
                    "mouthActivity": round(item.mouth_activity, 4),
                }
                for item in observations
            ],
        })
        sample_index += 1
        if progress_callback:
            progress_callback(sample_index / total_samples)
        # Avanza de forma secuencial hasta la siguiente muestra. grab() evita
        # decodificar imágenes que no se analizarán, pero conserva la
        # estabilidad de vídeos largos donde seek(frame) puede fallar.
        skipped = 0
        while skipped < step - 1 and frame_number + skipped + 1 < end_frame:
            if not capture.grab():
                break
            skipped += 1
        if skipped < step - 1 and frame_number + skipped + 1 < end_frame:
            break
        frame_number += step
    capture.release()
    return frames
