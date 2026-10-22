"""A small authenticated REST surface over the real Mem0 SDK.

Mem0 performs every storage, update, deletion and retrieval operation. Embeddings
run locally through its FastEmbed provider; Qdrant owns vector persistence.
The routes match the OSS API subset consumed by Conductor.
"""
import hmac
import logging
import os
from contextlib import asynccontextmanager
from importlib.metadata import version
from pathlib import Path
from threading import RLock
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from mem0 import Memory
from mem0.utils.factory import LlmFactory
from pydantic import BaseModel, Field

MODEL = "BAAI/bge-small-en-v1.5"
lock = RLock()
memory: Memory
api_key: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    global memory, api_key
    api_key = Path("/run/secrets/mem0_api_key").read_text().strip()
    if len(api_key) < 32:
        raise RuntimeError("Mem0 API key must contain at least 32 characters")
    Path("/data/mem0").mkdir(parents=True, exist_ok=True)
    # SDK 2.2 validates a fixed provider list even after register_provider().
    # Replace the unused default generation provider with an explicit guard;
    # infer=false never invokes it, and no cloud client/key is constructed.
    LlmFactory.register_provider("openai", "no_inference.VerbatimOnlyLLM")
    memory = Memory.from_config({
        "version": "v1.1",
        "vector_store": {"provider": "qdrant", "config": {
            "host": "qdrant", "port": 6333, "path": None,
            "collection_name": "conductor_memories", "embedding_model_dims": 384,
        }},
        "embedder": {"provider": "fastembed", "config": {"model": MODEL, "embedding_dims": 384}},
        "llm": {"provider": "openai", "config": {"model": "verbatim-only"}},
        "history_db_path": "/data/mem0/history.db",
    })
    # Download/cache and warm the real model before reporting readiness.
    memory.embedding_model.embed("Memory service is ready", "search")
    yield
    memory.vector_store.client.close()


app = FastAPI(title="Conductor Mem0", version="1.0.0", lifespan=lifespan)


def authenticate(x_api_key: str = Header(default="")):
    if not hmac.compare_digest(x_api_key, api_key):
        raise HTTPException(401, "A valid Mem0 API key is required")


def execute(operation):
    with lock:
        try:
            return operation()
        except HTTPException:
            raise
        except Exception as exc:
            # Avoid logging memory text, keys or provider exception bodies.
            logging.error("Mem0 operation failed (%s)", type(exc).__name__)
            raise HTTPException(502, "Mem0 operation failed") from None


class Message(BaseModel):
    role: Literal["user"] = "user"
    content: str = Field(min_length=1, max_length=100_000)


class CreateMemory(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=1)
    user_id: str = Field(min_length=1, max_length=255)
    run_id: str = Field(min_length=1, max_length=255)
    metadata: dict[str, Any] = Field(default_factory=dict)
    infer: Literal[False] = False


class SearchMemories(BaseModel):
    query: str = Field(min_length=1, max_length=100_000)
    filters: dict[str, Any]
    top_k: int = Field(default=50, ge=1, le=1000)


class UpdateMemory(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=100_000)
    metadata: dict[str, Any] | None = None


@app.get("/health")
def health():
    return {"status": "ready", "mem0_version": version("mem0ai"), "embedding_model": MODEL,
            "embeddings": "local", "vector_store": "qdrant", "inference": False}


@app.post("/memories", dependencies=[Depends(authenticate)])
def add(body: CreateMemory):
    return execute(lambda: memory.add(messages=[m.model_dump() for m in body.messages],
        user_id=body.user_id, run_id=body.run_id, metadata=body.metadata, infer=False))


@app.get("/memories", dependencies=[Depends(authenticate)])
def list_memories(user_id: str = Query(min_length=1), run_id: str | None = None,
                  top_k: int = Query(default=1000, ge=1, le=1000), show_expired: bool = True):
    filters = {"user_id": user_id, **({"run_id": run_id} if run_id else {})}
    return execute(lambda: memory.get_all(filters=filters, top_k=top_k, show_expired=show_expired))


@app.post("/search", dependencies=[Depends(authenticate)])
def search(body: SearchMemories):
    if not isinstance(body.filters.get("user_id"), str) or not body.filters["user_id"].strip():
        raise HTTPException(422, "A user_id scope is required")
    return execute(lambda: memory.search(query=body.query, filters=body.filters, top_k=body.top_k))


def require_memory(memory_id: str):
    found = memory.get(memory_id)
    if found is None:
        raise HTTPException(404, "Memory not found")
    return found


@app.get("/memories/{memory_id}", dependencies=[Depends(authenticate)])
def get(memory_id: str):
    return execute(lambda: require_memory(memory_id))


@app.put("/memories/{memory_id}", dependencies=[Depends(authenticate)])
def update(memory_id: str, body: UpdateMemory):
    def operation():
        require_memory(memory_id)
        fields = {}
        if body.text is not None:
            fields["data"] = body.text
        if body.metadata is not None:
            fields["metadata"] = body.metadata
        return memory.update(memory_id=memory_id, **fields)
    return execute(operation)


@app.delete("/memories/{memory_id}", dependencies=[Depends(authenticate)])
def delete(memory_id: str):
    def operation():
        require_memory(memory_id)
        memory.delete(memory_id=memory_id)
        return {"message": "Memory deleted"}
    return execute(operation)
