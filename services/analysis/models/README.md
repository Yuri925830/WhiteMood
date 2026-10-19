# Local model weights

This directory stores runtime-only visual model weights and is excluded from Git.

Current models:

| File | Runtime | Expected size | SHA-256 |
| --- | --- | ---: | --- |
| `enet_b0_8_best_afew.pt` | PyTorch/CUDA (default) | `16419305` bytes | `47c1423f3e6f50e3750bf7b0eda7db947c9ce0c2637e1766bf2187eddc652b17` |
| `enet_b0_8_best_afew.onnx` | ONNX/CPU (optional) | `16039595` bytes | `7aa2ea31c1311f4f8aa9d3fdb085d418dd4e7a48c4b9ed41df8c044f91d0213f` |

Both files come from EmotiEffLib commit `520a051c64cd191521e5934655314e769a319684`. EmotiEffLib normally reads them from `~/.emotiefflib/`; the local development setup links those cache entries to this directory so the analysis service does not download weights during first inference.
