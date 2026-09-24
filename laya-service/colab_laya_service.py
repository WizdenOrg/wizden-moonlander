"""Run a GPU-backed Laya API in Google Colab and expose it temporarily.

In Colab, select Runtime > Change runtime type > T4 GPU, then run:

    !wget -q https://raw.githubusercontent.com/WizdenOrg/wizden-moonlander/main/laya-service/colab_laya_service.py
    !python colab_laya_service.py

Keep the cell running. It prints a temporary public URL and an API token for
calls from your local machine. Paste both into the Moon Lander's top bar. Stop the cell to shut down the service.
"""
import asyncio
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.request import urlopen


def select_port() -> int:
    preferred_port = int(os.environ.get("LAYA_PORT", "8080"))
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", preferred_port))
            return preferred_port
        except OSError:
            probe.bind(("127.0.0.1", 0))
            return int(probe.getsockname()[1])


PORT = select_port()
MODEL = "english"  # Change to "multilingual" for a multilingual workflow pilot.
API_TOKEN = os.environ.get("LAYA_API_TOKEN") or secrets.token_urlsafe(32)


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def install_dependencies() -> None:
    # Colab supplies CUDA PyTorch. Do not reinstall torch and lose GPU support.
    run([sys.executable, "-m", "pip", "install", "--quiet", "fastapi>=0.115,<1", "uvicorn[standard]>=0.30,<1", "laya==0.3.5"])
    cloudflared = Path("/usr/local/bin/cloudflared")
    if not cloudflared.exists():
        run([
            "wget", "--quiet", "--output-document", str(cloudflared),
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
        ])
        cloudflared.chmod(0o755)


def wait_for_ready() -> None:
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        try:
            with urlopen(f"http://127.0.0.1:{PORT}/health/ready", timeout=3) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(2)
    raise RuntimeError("Laya did not become ready within 15 minutes.")


def start_tunnel() -> tuple[subprocess.Popen[str], str]:
    process = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{PORT}", "--no-autoupdate"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None
    for line in process.stdout:
        match = re.search(r"https://[-a-z0-9]+\.trycloudflare\.com", line)
        if match:
            return process, match.group(0)
    raise RuntimeError("Cloudflare Tunnel stopped before providing a public URL.")


def main() -> None:
    install_dependencies()

    import torch
    import uvicorn
    from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
    from pydantic import BaseModel, ConfigDict, Field, model_validator
    from typing import Any, Literal
    from laya import Router

    if not torch.cuda.is_available():
        raise RuntimeError("No CUDA GPU is available. Select a T4 GPU runtime in Colab and rerun.")

    class Question(BaseModel):
        model_config = ConfigDict(extra="forbid")
        type: Literal["choice", "score", "noul"]
        instructions: str
        criteria: dict[str, Any] | list[Any] | None = None

        @model_validator(mode="after")
        def validate_criteria(self) -> "Question":
            if self.type == "choice" and not self.criteria:
                raise ValueError("choice questions require non-empty criteria")
            if self.type == "score" and (not isinstance(self.criteria, list) or len(self.criteria) < 2):
                raise ValueError("score questions require at least two criteria levels")
            return self

    class DecisionRequest(BaseModel):
        model_config = ConfigDict(extra="forbid")
        state: str | dict[str, Any] | list[Any]
        questions: dict[str, Question] = Field(min_length=1)
        model: str | None = None
        task: str | None = None
        lang: str | None = None

    router = Router(device="cuda", max_loaded=1)
    inference_lock = threading.Semaphore(1)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        print(f"GPU: {torch.cuda.get_device_name(0)} | CUDA: {torch.version.cuda}", flush=True)
        print(f"Downloading and warming {MODEL!r}; first launch can take several minutes.", flush=True)
        await asyncio.to_thread(router.preload, [MODEL])
        app.state.ready = True
        yield
        router.unload()

    app = FastAPI(title="Laya Colab GPU API", version="0.1.0", lifespan=lifespan)


    def require_token(x_api_key: str | None = Header(default=None)) -> None:
        if not secrets.compare_digest(x_api_key or "", API_TOKEN):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid X-API-Key")

    @app.get("/health/live")
    def live() -> dict[str, str]:
        return {"status": "live"}

    @app.get("/health/ready")
    def ready() -> dict[str, str]:
        if not getattr(app.state, "ready", False):
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="model not ready")
        return {"status": "ready", "device": "cuda"}

    @app.post("/v1/decisions")
    def decision(payload: DecisionRequest, request: Request, _: None = Depends(require_token)) -> dict[str, Any]:
        if not getattr(app.state, "ready", False):
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="model not ready")
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        started = time.perf_counter()
        queued_at = time.perf_counter()
        with inference_lock:
            queue_ms = (time.perf_counter() - queued_at) * 1000
            inference_started = time.perf_counter()
            result = router.predict(
                payload.state,
                {key: value.model_dump(exclude_none=True) for key, value in payload.questions.items()},
                model=payload.model or MODEL,
                task=payload.task,
                lang=payload.lang,
            )
            inference_ms = (time.perf_counter() - inference_started) * 1000
        return {
            "request_id": request_id,
            "answers": result["answers"],
            "routing": {**dict(result.get("routing", {})), "device": "cuda"},
            "timing": {
                "queue_ms": round(queue_ms, 3),
                "inference_ms": round(inference_ms, 3),
                "total_ms": round((time.perf_counter() - started) * 1000, 3),
            },
        }

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, workers=1, log_level="info"))
    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()
    wait_for_ready()
    tunnel, public_url = start_tunnel()
    print("\nLaya GPU API is ready", flush=True)
    print(f"Colab local port: {PORT}", flush=True)
    print(f"Public URL: {public_url}", flush=True)
    print(f"API token: {API_TOKEN}", flush=True)
    print("\nLocal test command:", flush=True)
    example_payload = json.dumps({
        "state": {"message": "I was charged twice and need a refund."},
        "questions": {
            "route": {
                "type": "choice",
                "instructions": "Which team should handle this?",
                "criteria": {
                    "billing": "payments and refunds",
                    "technical": "bugs and outages",
                    "sales": "pricing and purchases",
                },
            }
        },
    })
    print(
        f"curl -X POST '{public_url}/v1/decisions' -H 'Content-Type: application/json' "
        f"-H 'X-API-Key: {API_TOKEN}' -d '{example_payload}'",
        flush=True,
    )
    try:
        while server_thread.is_alive() and tunnel.poll() is None:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        server.should_exit = True
        tunnel.terminate()


if __name__ == "__main__":
    main()
