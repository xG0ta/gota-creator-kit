from pydantic import BaseModel, Field, model_validator


class AnalyzeRequest(BaseModel):
    version: str = "1.0"
    mediaPath: str = Field(min_length=1)
    targetAspect: float = Field(gt=0)
    sampleFps: float = Field(default=2.0, ge=0.2, le=15)
    margin: float = Field(default=1.25, ge=0, le=2)
    smoothing: float = Field(default=0.75, ge=0, le=0.99)
    startSeconds: float = Field(default=0, ge=0)
    endSeconds: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def valid_range(self):
        if self.endSeconds is not None and self.endSeconds <= self.startSeconds:
            raise ValueError("endSeconds debe ser mayor que startSeconds")
        return self


class CropKeyframe(BaseModel):
    timeSeconds: float
    centerX: float
    centerY: float
    width: float
    height: float
    confidence: float
    mouthActivity: float = 0.0


class AnalyzeResponse(BaseModel):
    version: str = "1.0"
    sourceWidth: int
    sourceHeight: int
    durationSeconds: float
    meanConfidence: float
    warnings: list[str]
    keyframes: list[CropKeyframe]
    layoutFrames: list[dict] = Field(default_factory=list)
    singleFrames: int = 0
    splitFrames: int = 0
    sceneCuts: list[float] = Field(default_factory=list)
    sceneCutCount: int = 0
