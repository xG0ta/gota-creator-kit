from dataclasses import dataclass, field
from math import hypot


@dataclass
class FaceObservation:
    time: float
    x: float
    y: float
    width: float
    height: float
    confidence: float
    mouth_activity: float = 0.0
    subject_id: str = ""

    @property
    def center(self):
        return self.x + self.width / 2, self.y + self.height / 2


@dataclass
class SubjectTrack:
    subject_id: str
    last_center: tuple[float, float]
    last_time: float
    observations: list[FaceObservation] = field(default_factory=list)


class IdentityTracker:
    """Stable A/B identity assignment using temporal proximity and screen side."""

    def __init__(
        self,
        max_distance: float = 0.34,
        max_gap: float = 5.0,
        max_subjects: int = 2,
    ):
        self.max_distance = max_distance
        self.max_gap = max_gap
        self.max_subjects = max_subjects
        self.tracks: dict[str, SubjectTrack] = {}

    def reset_scene(self):
        for track in self.tracks.values():
            track.last_time = -9999

    def assign(self, observations: list[FaceObservation]) -> list[FaceObservation]:
        observations = sorted(observations, key=lambda item: item.center[0])
        if self.max_subjects == 2 and len(observations) >= 2:
            # En podcast, el orden visual es más estable que la posición tras
            # un cambio de cámara. Evita crear P3/P4 por cada corte.
            for index, observation in enumerate(observations[:2]):
                subject_id = "A" if index == 0 else "B"
                track = self.tracks.get(subject_id) or SubjectTrack(
                    subject_id, observation.center, observation.time
                )
                self.tracks[subject_id] = track
                observation.subject_id = subject_id
                track.last_center = observation.center
                track.last_time = observation.time
                track.observations.append(observation)
            return observations[:2]
        available = {
            key: track for key, track in self.tracks.items()
            if observations and observations[0].time - track.last_time <= self.max_gap
        }
        assigned: list[FaceObservation] = []

        for observation in observations:
            ox, oy = observation.center
            matches = []
            for subject_id, track in available.items():
                tx, ty = track.last_center
                distance = hypot(ox - tx, oy - ty)
                if distance <= self.max_distance:
                    matches.append((distance, subject_id, track))
            if matches:
                _, subject_id, track = min(matches)
                del available[subject_id]
            else:
                subject_id = self._next_subject_id(ox)
                track = self.tracks.get(subject_id) or SubjectTrack(
                    subject_id, (ox, oy), observation.time
                )
                self.tracks[subject_id] = track

            observation.subject_id = subject_id
            track.last_center = (ox, oy)
            track.last_time = observation.time
            track.observations.append(observation)
            assigned.append(observation)
        return assigned

    def _next_subject_id(self, center_x: float) -> str:
        if "A" not in self.tracks and "B" not in self.tracks:
            return "A" if center_x <= 0.5 else "B"
        if "A" not in self.tracks:
            return "A"
        if "B" not in self.tracks:
            return "B"
        if self.max_subjects == 2:
            return min(
                ("A", "B"),
                key=lambda subject_id: abs(
                    self.tracks[subject_id].last_center[0] - center_x
                ),
            )
        index = 3
        while f"P{index}" in self.tracks:
            index += 1
        return f"P{index}"


def choose_speaker(
    observations: list[FaceObservation],
    previous_speaker: str | None = None,
    hysteresis: float = 0.035,
) -> str | None:
    if not observations:
        return previous_speaker
    scores = {
        item.subject_id: item.mouth_activity * 3.0 + item.confidence * 0.15
        for item in observations
    }
    winner = max(scores, key=scores.get)
    if previous_speaker in scores:
        if scores[winner] - scores[previous_speaker] < hysteresis:
            return previous_speaker
    return winner
