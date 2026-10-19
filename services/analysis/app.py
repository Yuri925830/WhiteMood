from __future__ import annotations

import asyncio
import importlib.util
import os
import secrets
import time
from collections.abc import Callable
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from .audio import analyze_acoustics
from .errors import ComponentUnavailable
from .face import analyze_faces

MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_FRAME_BYTES = 256 * 1024
MAX_FRAMES = 5

app = FastAPI(title="WhiteMood local analysis", version="1.0.0")


async def authorize(
    supplied: Annotated[str | None, Header(alias="X-WhiteMood-Analysis-Token")] = None,
) -> None:
    expected = os.getenv("WHITEMOOD_ANALYSIS_TOKEN", "").strip()
    if expected and (not supplied or not secrets.compare_digest(supplied, expected)):
        raise HTTPException(status_code=401, detail="analysis authentication required")


async def read_upload(upload: UploadFile, limit: int, allowed_types: set[str]) -> bytes:
    if upload.content_type not in allowed_types:
        raise HTTPException(status_code=415, detail="unsupported media type")
    chunks: list[bytes] = []
    size = 0
    try:
        while chunk := await upload.read(64 * 1024):
            size += len(chunk)
            if size > limit:
                raise HTTPException(status_code=413, detail="upload is too large")
            chunks.append(chunk)
    finally:
        await upload.close()
    if not chunks:
        raise HTTPException(status_code=400, detail="empty upload")
    return b"".join(chunks)


async def run_component(function: Callable[..., Any], *args: Any) -> tuple[Any, dict[str, Any]]:
    started = time.perf_counter()
    try:
        value = await asyncio.to_thread(function, *args)
        latency = round((time.perf_counter() - started) * 1000)
        if value is None:
            return None, {"status": "skipped", "latencyMs": latency}
        confidence = value.get("confidence", value.get("quality")) if isinstance(value, dict) else None
        module = {"status": "ok", "latencyMs": latency}
        if isinstance(confidence, (int, float)) and 0 <= confidence <= 1:
            module["confidence"] = round(float(confidence), 4)
        return value, module
    except ComponentUnavailable:
        return None, {"status": "unavailable", "latencyMs": round((time.perf_counter() - started) * 1000)}
    except Exception:  # Model runtimes use backend-specific exception classes; never expose them.
        return None, {"status": "error", "latencyMs": round((time.perf_counter() - started) * 1000)}


def packages_available(names: list[str]) -> bool:
    return all(importlib.util.find_spec(name) is not None for name in names)


def face_runtime_available() -> bool:
    engine = os.getenv("WHITEMOOD_FACE_ENGINE", "torch")
    if engine == "torch":
        if not packages_available(["cv2", "PIL", "emotiefflib", "torch", "torchvision", "timm"]):
            return False
        if os.getenv("WHITEMOOD_FACE_DEVICE", "cuda").startswith("cuda"):
            try:
                import torch
            except (ImportError, OSError):
                return False

            return bool(torch.cuda.is_available())
        return True
    return packages_available(["cv2", "PIL", "emotiefflib", "onnx", "onnxruntime"])


@app.get("/health")
async def health(_: Annotated[None, Depends(authorize)]) -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "components": {
                "acoustics": {"available": packages_available(["librosa", "silero_vad", "torch"])},
                "face": {"available": face_runtime_available()},
            },
        },
        headers={"Cache-Control": "no-store"},
    )


@app.post("/v1/analyze/audio")
async def analyze_audio_endpoint(
    _: Annotated[None, Depends(authorize)],
    audio: Annotated[UploadFile, File()],
) -> dict[str, Any]:
    data = await read_upload(audio, MAX_AUDIO_BYTES, {"audio/wav", "audio/wave", "audio/x-wav"})
    acoustics, module = await run_component(analyze_acoustics, data)
    return {"acoustics": acoustics, "modules": {"acoustics": module}}


async def read_frames(frames: list[UploadFile]) -> list[bytes]:
    if len(frames) < 2 or len(frames) > MAX_FRAMES:
        raise HTTPException(status_code=400, detail="provide two to five JPEG frames")
    return await asyncio.gather(
        *(read_upload(frame, MAX_FRAME_BYTES, {"image/jpeg"}) for frame in frames)
    )


@app.post("/v1/analyze/faces")
async def analyze_faces_endpoint(
    _: Annotated[None, Depends(authorize)],
    frames: Annotated[list[UploadFile], File()],
) -> dict[str, Any]:
    images = await read_frames(frames)
    face, module = await run_component(analyze_faces, images)
    return {"face": face, "modules": {"face": module}}


@app.post("/v1/analyze/turn")
async def analyze_turn_endpoint(
    _: Annotated[None, Depends(authorize)],
    audio: Annotated[UploadFile, File()],
    frames: Annotated[list[UploadFile] | None, File()] = None,
    captured_at: Annotated[list[str] | None, Form()] = None,
) -> dict[str, Any]:
    frame_uploads = frames or []
    timestamps = captured_at or []
    if len(frame_uploads) != len(timestamps) or (frame_uploads and len(frame_uploads) < 2) or len(frame_uploads) > MAX_FRAMES:
        raise HTTPException(status_code=400, detail="camera frames and timestamps must match")
    if any(not value.isdigit() for value in timestamps):
        raise HTTPException(status_code=400, detail="invalid frame timestamp")
    audio_data, images = await asyncio.gather(
        read_upload(audio, MAX_AUDIO_BYTES, {"audio/wav", "audio/wave", "audio/x-wav"}),
        read_frames(frame_uploads) if frame_uploads else asyncio.sleep(0, result=[]),
    )
    acoustic_task = run_component(analyze_acoustics, audio_data)
    face_task = run_component(analyze_faces, images) if images else None
    if face_task:
        (acoustics, acoustic_module), (face, face_module) = await asyncio.gather(acoustic_task, face_task)
    else:
        acoustics, acoustic_module = await acoustic_task
        face, face_module = None, {"status": "skipped", "latencyMs": 0}
    return {
        "acoustics": acoustics,
        "face": face,
        "modules": {"acoustics": acoustic_module, "face": face_module},
    }
