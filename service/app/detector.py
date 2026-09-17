from pathlib import Path
from collections.abc import Callable
import os

import cv2
import numpy as np

from .planner import Detection, DetectionFrame


def analyze_video(
    path: Path,
    sample_fps: float,
    start: float,
    end: float | None,
    progress_callback: Callable[[float], None] | None = None,
):
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise ValueError("No se pudo abrir el archivo de video")

    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
    duration = frame_count / fps if fps else 0
    stop = min(end, duration) if end is not None else duration
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(cascade_path)
    profile_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_profileface.xml"
    )
    cv2.setNumThreads(max(2, (os.cpu_count() or 4) - 1))
    detections: list[Detection] = []
    frames: list[DetectionFrame] = []
    scene_cuts: list[float] = []
    previous_histogram = None
    previous_face_patches: list[tuple[float, float, np.ndarray]] = []
    detection_width = min(width, 640)
    detection_scale = detection_width / width
    detection_height = max(1, round(height * detection_scale))

    start_frame = max(0, round(start * fps))
    stop_frame = max(start_frame, round(stop * fps))
    sample_step_frames = max(1, round(fps / sample_fps))
    scene_step_frames = max(1, round(fps / 4.0))
    scene_cut_since_face_sample = False
    capture.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    frame_number = start_frame

    while frame_number <= stop_frame:
        ok = capture.grab()
        if not ok:
            break
        should_sample = (frame_number - start_frame) % sample_step_frames == 0
        should_check_scene = (
            (frame_number - start_frame) % scene_step_frames == 0
        )
        if not should_sample and not should_check_scene:
            frame_number += 1
            continue
        ok, frame = capture.retrieve()
        if not ok:
            break
        sample_time = frame_number / fps
        small = cv2.resize(
            frame, (detection_width, detection_height),
            interpolation=cv2.INTER_AREA
        )
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        scene_cut = False
        if should_check_scene:
            histogram = cv2.calcHist([gray], [0], None, [64], [0, 256])
            cv2.normalize(histogram, histogram)
            if previous_histogram is not None:
                correlation = cv2.compareHist(
                    previous_histogram, histogram, cv2.HISTCMP_CORREL
                )
                scene_cut = correlation < 0.72
                if scene_cut:
                    scene_cuts.append(round(sample_time, 4))
                    scene_cut_since_face_sample = True
                    previous_face_patches = []
            previous_histogram = histogram
        if not should_sample:
            frame_number += 1
            continue
        equalized = cv2.equalizeHist(gray)
        frontal = cascade.detectMultiScale(
            equalized, scaleFactor=1.08, minNeighbors=6,
            minSize=(max(24, detection_width // 40),
                     max(24, detection_height // 40))
        )
        profiles = profile_cascade.detectMultiScale(
            equalized, scaleFactor=1.1, minNeighbors=6,
            minSize=(max(28, detection_width // 35),
                     max(28, detection_height // 35))
        )
        mirrored = cv2.flip(equalized, 1)
        mirrored_profiles = profile_cascade.detectMultiScale(
            mirrored, scaleFactor=1.1, minNeighbors=6,
            minSize=(max(28, detection_width // 35),
                     max(28, detection_height // 35))
        )
        candidates = list(frontal) + list(profiles) + [
            (detection_width - x - w, y, w, h)
            for x, y, w, h in mirrored_profiles
        ]
        candidates = sorted(
            candidates, key=lambda box: box[2] * box[3], reverse=True
        )
        unique_faces = []
        for box in candidates:
            x, y, w, h = box
            center = (x + w / 2, y + h / 2)
            duplicate = any(
                abs(center[0] - (ox + ow / 2)) < max(w, ow) * 0.35 and
                abs(center[1] - (oy + oh / 2)) < max(h, oh) * 0.35
                for ox, oy, ow, oh in unique_faces
            )
            if not duplicate:
                unique_faces.append(box)
            if len(unique_faces) == 2:
                break

        current_patches = []
        detected = []
        for x, y, w, h in unique_faces:
            mouth_y = min(detection_height, y + round(h * 0.52))
            mouth = gray[mouth_y:min(detection_height, y + h), x:x + w]
            patch = (
                cv2.resize(mouth, (48, 24), interpolation=cv2.INTER_AREA)
                if mouth.size else np.zeros((24, 48), dtype=np.uint8)
            )
            cx = (x + w / 2) / detection_width
            cy = (y + h / 2) / detection_height
            activity = 0.0
            nearby = [
                old_patch for old_x, old_y, old_patch in previous_face_patches
                if abs(old_x - cx) < 0.18 and abs(old_y - cy) < 0.18
            ]
            if nearby:
                activity = float(
                    np.mean(cv2.absdiff(patch, nearby[0])) / 255.0
                )
            current_patches.append((cx, cy, patch))
            detected.append(Detection(
                time=sample_time,
                x=x / detection_width,
                y=y / detection_height,
                width=w / detection_width,
                height=h / detection_height,
                confidence=0.7,
                mouth_activity=activity,
            ))
        previous_face_patches = current_patches
        frame_faces = tuple(detected)
        frames.append(DetectionFrame(
            time=sample_time,
            faces=frame_faces,
            scene_cut=scene_cut_since_face_sample,
        ))
        scene_cut_since_face_sample = False
        if frame_faces:
            detections.append(max(
                frame_faces,
                key=lambda face: face.mouth_activity * 3 + face.width * face.height
            ))
        if progress_callback:
            span_frames = max(1, stop_frame - start_frame)
            progress_callback(min(1.0, (frame_number - start_frame) / span_frames))
        frame_number += 1

    capture.release()
    if progress_callback:
        progress_callback(1.0)
    return width, height, duration, detections, frames, scene_cuts
