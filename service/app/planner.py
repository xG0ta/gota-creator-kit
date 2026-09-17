from dataclasses import dataclass


@dataclass(frozen=True)
class Detection:
    time: float
    x: float
    y: float
    width: float
    height: float
    confidence: float
    mouth_activity: float = 0.0


@dataclass(frozen=True)
class DetectionFrame:
    time: float
    faces: tuple[Detection, ...]
    scene_cut: bool = False


def plan_crops(
    detections: list[Detection],
    source_aspect: float,
    target_aspect: float,
    margin: float,
    smoothing: float,
) -> list[dict]:
    """Convert normalized face boxes into bounded, smoothed crop keyframes."""
    output: list[dict] = []
    previous_x = previous_y = None

    for face in detections:
        # Include shoulders and headroom: face occupies roughly 1/(2.2 * margin)
        crop_h = min(1.0, max(0.12, face.height * 2.2 * margin))
        crop_w = crop_h * target_aspect / source_aspect
        if crop_w > 1.0:
            crop_w = 1.0
            crop_h = source_aspect / target_aspect

        raw_x = face.x + face.width / 2
        raw_y = face.y + face.height * 0.42  # small headroom bias
        if previous_x is None:
            center_x, center_y = raw_x, raw_y
        else:
            center_x = smoothing * previous_x + (1 - smoothing) * raw_x
            center_y = smoothing * previous_y + (1 - smoothing) * raw_y

        center_x = min(1 - crop_w / 2, max(crop_w / 2, center_x))
        center_y = min(1 - crop_h / 2, max(crop_h / 2, center_y))
        previous_x, previous_y = center_x, center_y
        output.append({
            "timeSeconds": round(face.time, 4),
            "centerX": round(center_x, 6),
            "centerY": round(center_y, 6),
            "width": round(crop_w, 6),
            "height": round(crop_h, 6),
            "confidence": round(face.confidence, 4),
            "mouthActivity": round(face.mouth_activity, 4),
        })
    return output


def plan_podcast_layout(
    frames: list[DetectionFrame],
    source_aspect: float,
    margin: float,
    smoothing: float,
) -> list[dict]:
    """Create stable single/split layouts for a vertical 9:16 canvas."""
    output: list[dict] = []
    previous: dict[str, tuple[float, float]] = {}

    for frame in frames:
        if frame.scene_cut:
            previous.clear()
        faces = sorted(frame.faces, key=lambda face: face.x + face.width / 2)
        if not faces:
            output.append({
                "timeSeconds": round(frame.time, 4),
                "mode": "hold",
                "subjects": [],
            })
            continue

        selected = faces[:2] if len(faces) >= 2 else faces[:1]
        mode = "split" if len(selected) == 2 else "single"
        subjects = []

        for index, face in enumerate(selected):
            slot = ("top" if index == 0 else "bottom") if mode == "split" else "full"
            target_aspect = (9 / 8) if mode == "split" else (9 / 16)
            crop_h = min(1.0, max(0.12, face.height * 2.2 * margin))
            crop_w = crop_h * target_aspect / source_aspect
            if crop_w > 1:
                crop_w = 1.0
                crop_h = min(1.0, source_aspect / target_aspect)

            raw_x = face.x + face.width / 2
            raw_y = face.y + face.height * 0.42
            old = previous.get(slot)
            if old:
                center_x = smoothing * old[0] + (1 - smoothing) * raw_x
                center_y = smoothing * old[1] + (1 - smoothing) * raw_y
            else:
                center_x, center_y = raw_x, raw_y

            center_x = min(1 - crop_w / 2, max(crop_w / 2, center_x))
            center_y = min(1 - crop_h / 2, max(crop_h / 2, center_y))
            previous[slot] = (center_x, center_y)
            subjects.append({
                "slot": slot,
                "centerX": round(center_x, 6),
                "centerY": round(center_y, 6),
                "width": round(crop_w, 6),
                "height": round(crop_h, 6),
                "confidence": round(face.confidence, 4),
                "mouthActivity": round(face.mouth_activity, 4),
            })

        output.append({
            "timeSeconds": round(frame.time, 4),
            "mode": mode,
            "subjects": subjects,
        })
    return output
