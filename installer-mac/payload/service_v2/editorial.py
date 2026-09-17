from dataclasses import dataclass


PROFILES = {
    "camera_shots": {
        "label": "Por cambios de cámara",
        "minShotSeconds": 0.0,
        "speakerDelaySeconds": 0.0,
        "reactionSeconds": 0.0,
        "splitOnOverlap": True,
    },
    "podcast_calm": {
        "label": "Podcast tranquilo",
        "minShotSeconds": 3.0,
        "speakerDelaySeconds": 0.55,
        "reactionSeconds": 1.2,
        "splitOnOverlap": True,
    },
    "podcast_dynamic": {
        "label": "Podcast dinámico",
        "minShotSeconds": 1.8,
        "speakerDelaySeconds": 0.3,
        "reactionSeconds": 0.8,
        "splitOnOverlap": True,
    },
    "reels_fast": {
        "label": "Reels rápidos",
        "minShotSeconds": 1.0,
        "speakerDelaySeconds": 0.2,
        "reactionSeconds": 0.55,
        "splitOnOverlap": False,
    },
}


@dataclass
class EditorialFrame:
    time: float
    speaker_id: str | None
    subject_ids: tuple[str, ...]
    confidence: float
    overlap: bool = False


def build_shot_plan(
    frames: list[EditorialFrame],
    profile_name: str = "podcast_dynamic",
    rule_overrides: dict | None = None,
):
    if not frames:
        return [], [{"type": "no_faces", "timeSeconds": 0}]
    profile = dict(PROFILES.get(profile_name, PROFILES["podcast_dynamic"]))
    if rule_overrides:
        profile.update({
            key: value for key, value in rule_overrides.items()
            if key in {
                "minShotSeconds",
                "speakerDelaySeconds",
                "reactionSeconds",
                "splitOnOverlap",
            }
        })
    min_duration = profile["minShotSeconds"]
    speaker_delay = profile["speakerDelaySeconds"]
    plan = []
    warnings = []
    current = None
    pending_speaker = None
    pending_since = 0.0

    for frame in frames:
        desired_mode = (
            "split"
            if profile["splitOnOverlap"] and frame.overlap and len(frame.subject_ids) >= 2
            else "single"
        )
        desired_subject = frame.speaker_id
        if current is None:
            current = {
                "startSeconds": frame.time,
                "endSeconds": frame.time,
                "mode": desired_mode,
                "subjectId": desired_subject,
                "confidence": frame.confidence,
            }
            continue

        current["endSeconds"] = frame.time
        current["confidence"] = min(current["confidence"], frame.confidence)
        changed = (
            desired_mode != current["mode"]
            or (
                desired_mode == "single"
                and desired_subject
                and desired_subject != current["subjectId"]
            )
        )
        if not changed:
            pending_speaker = None
            continue

        if pending_speaker != (desired_mode, desired_subject):
            pending_speaker = (desired_mode, desired_subject)
            pending_since = frame.time
            continue
        stable_for = frame.time - pending_since
        shot_duration = frame.time - current["startSeconds"]
        if stable_for >= speaker_delay and shot_duration >= min_duration:
            transition_time = max(
                pending_since,
                current["startSeconds"] + min_duration,
            )
            current["endSeconds"] = transition_time
            plan.append(current)
            current = {
                "startSeconds": transition_time,
                "endSeconds": frame.time,
                "mode": desired_mode,
                "subjectId": desired_subject,
                "confidence": frame.confidence,
            }
            pending_speaker = None

    if current:
        plan.append(current)

    for shot in plan:
        duration = shot["endSeconds"] - shot["startSeconds"]
        if shot["confidence"] < 0.72:
            warnings.append({
                "type": "low_confidence",
                "timeSeconds": round(shot["startSeconds"], 3),
                "message": "Encuadre dudoso: revisa este segmento.",
            })
        if duration < 0.75:
            warnings.append({
                "type": "short_shot",
                "timeSeconds": round(shot["startSeconds"], 3),
                "message": "Plano demasiado corto.",
            })
    return plan, warnings
