import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "services.analysis.app:app",
        host="127.0.0.1",
        port=int(os.getenv("WHITEMOOD_ANALYSIS_PORT", "8790")),
        access_log=False,
    )
