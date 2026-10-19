# WhiteMood local analysis service

This optional loopback FastAPI service implements the local half of WhiteMood's hybrid pipeline:

- `librosa` + Silero VAD for acoustic measurements;
- OpenCV face detection + EmotiEffLib PyTorch/CUDA inference for facial-expression cues;
- independent module status, latency and confidence in one turn response.

Start it from the repository root:

```bash
python3.10 -m venv .venv-analysis
source .venv-analysis/bin/activate
pip install -r services/analysis/requirements-gpu-cu118.txt
export WHITEMOOD_ANALYSIS_TOKEN="use-a-random-secret"
python -m services.analysis
```

Then set `ANALYSIS_API_URL=http://127.0.0.1:8790` and the matching `ANALYSIS_API_TOKEN` in the main application's server environment. Do not expose the loopback development server directly to the internet.

The face recognizer defaults to `WHITEMOOD_FACE_ENGINE=torch` and `WHITEMOOD_FACE_DEVICE=cuda`; it fails closed when CUDA is unavailable rather than silently running visual inference on the CPU. The service keeps uploads in memory, has no persistence code, and disables Uvicorn access logging in its module entry point. The official model is stored in `services/analysis/models/` and linked into EmotiEffLib's user cache. See [`docs/CV_HANDOFF.md`](../../docs/CV_HANDOFF.md) for the data contract, limits, privacy behavior and validation commands.
