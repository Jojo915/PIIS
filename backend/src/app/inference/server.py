"""Contains code to start a vLLM served LLM."""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import time

import requests

vllm_process = None


def start_vllm_server(
    model: str = "meta-llama/Llama-3.2-1B-Instruct",
    max_model_len: int = 1028,
) -> None:
    """Start vLLM server."""
    global vllm_process

    vllm_process = subprocess.Popen(
        [
            "vllm",
            "serve",
            model,
            "--tensor-parallel-size",
            "1",
            "--dtype",
            "float16",
            "--port",
            "8000",
            "--max-model-len",
            str(max_model_len),
            "--enforce-eager",
        ],
        start_new_session=True,
    )

    for _ in range(60):
        try:
            response = requests.get("http://localhost:8000/health")
            if response.status_code == 200:
                print("server is up!")
                return
        except requests.exceptions.RequestException:
            time.sleep(5)

    raise RuntimeError("vLLM server did not start")


def close_vllm_server() -> None:
    """Close the vLLM server."""
    global vllm_process
    if vllm_process is not None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(os.getpgid(vllm_process.pid), signal.SIGTERM)
        vllm_process.wait()
        vllm_process = None
        time.sleep(5)
        print("server closed!")
