from pathlib import Path
import logging
import hmac
from pydantic import BaseModel, Field
from fastapi import APIRouter, UploadFile, File, HTTPException, Header

from agent.core.config import get_settings
from agent.rag.workflow import ask
from agent.rag.vectorstore import add_documents
from agent.services.audit import write_audit
from agent.services.ingestion import load_file, chunk_documents, SUPPORTED

router = APIRouter(prefix="/api")
settings = get_settings()
logger = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    question: str = Field(min_length=2, max_length=5000)


@router.get("/health")
def health():
    return {"status": "Ok", "service": settings.app_name}


@router.get("/status")
def status():
    checks = {
        "groq": {
            "label": "AI responses (Groq)",
            "configured": bool(settings.groq_api_key.strip()),
        },
        "pinecone": {
            "label": "Private knowledge base (Pinecone)",
            "configured": bool(settings.pinecone_api_key.strip()),
        },
        "tavily": {
            "label": "External web fallback (Tavily)",
            "configured": bool(settings.tavily_api_key.strip()),
        },
        "admin": {
            "label": "Secure document uploads",
            "configured": bool(settings.admin_api_key.strip())
            and settings.admin_api_key.strip().casefold() != "change-me",
        },
    }
    return {
        "readiness": "ready"
        if all(check["configured"] for check in checks.values())
        else "configuration_required",
        "checks": checks,
    }


@router.post("/chat")
def chat(payload: ChatRequest):
    try:
        result = ask(payload.question)
        write_audit(payload.question, result["source_used"], result.get("trace", []))

        return {
            "answer": result["answer"],
            "source_used": result["source_used"],
            "trace": result.get("trace", []),
            "citations": result.get("citations", []),
            "rewritten_query": result.get("current_query", payload.question),
        }
    except Exception as exc:
        logger.exception("Chat request failed")
        raise HTTPException(
            status_code=502,
            detail="The assistant is temporarily unavailable. Please try again shortly.",
        ) from exc


@router.post("/ingest")
async def ingest(file: UploadFile = File(...), x_admin_key: str = Header(default="")):
    configured_admin_key = settings.admin_api_key.strip()
    if not configured_admin_key or configured_admin_key.casefold() == "change-me":
        raise HTTPException(
            status_code=503,
            detail="Document uploads are unavailable until ADMIN_API_KEY is configured.",
        )
    if not hmac.compare_digest(x_admin_key, configured_admin_key):
        raise HTTPException(status_code=401, detail="Invalid admin key")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in SUPPORTED:
        raise HTTPException(
            status_code=400, detail=f"Supported: {', '.join(sorted(SUPPORTED))}"
        )
    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    filename = Path(file.filename or "").name
    if not filename:
        raise HTTPException(status_code=400, detail="A filename is required")
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="The selected document is empty")
    dest = upload_dir / filename
    dest.write_bytes(contents)
    docs = load_file(dest)
    chunks = chunk_documents(docs)
    ids = add_documents(chunks)
    return {
        "message": "Document indexed",
        "file": dest.name,
        "chunks": len(chunks),
        "ids_created": len(ids),
    }